// ==UserScript==
// @name         GeoGuessr Weekly Club Mission Overview
// @namespace    https://www.geoguessr.com/
// @version      1.11
// @description  Shows current status of the weekly mission progress per member
// @author       Gorakel
// @match        https://www.geoguessr.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=geoguessr.com
// @grant        none
// @license      MIT
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // =========================================================
    // 1. Settings
    // =========================================================
    const WEEKLY_MAX_XP = 280;       // XP a member can earn per week at most
    const DAILY_XP = 20;             // XP a member gets per day
    const DAY_MS = 24 * 3600 * 1000; // One day in milliseconds

    // =========================================================
    // 2. API access (uses the session cookie of the browser)
    // =========================================================

    // Fetches a GeoGuessr API path and returns the parsed JSON.
    async function fetchJson(path) {
        const res = await fetch(path, {
            credentials: 'include',            // send the login cookie along
            headers: { Accept: 'application/json' },
        });
        if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
        return res.json();
    }

    // =========================================================
    // 3. Helpers
    // =========================================================

    // Converts a value into a Date. Returns null for empty or invalid input.
    function parseDate(value) {
        const d = value ? new Date(value) : null;
        return d && !isNaN(d) ? d : null;
    }

    // Returns the later of two dates; either one may be null.
    // Short form of: if (!b) return a; if (!a) return b; return b > a ? b : a;
    const latest = (a, b) => (b && (!a || b > a) ? b : a);

    // How many boards a member must have claimed so far this week.
    // dayStart = start of the current mission day (the last daily reset).
    // The mission week starts on Saturday, so:
    //   Sat -> 1, Sun -> 2, Mon -> 3, Tue -> 4, Wed -> 5, Thu -> 6, Fri -> 7
    // Simplified: the original "(Monday-based weekday + 5) % 7 + 1" collapses to
    // "(JS weekday + 4) % 7 + 1" (JS weekday: Sun = 0 ... Sat = 6).
    function expectedClaims(dayStart) {
        return ((dayStart.getDay() + 4) % 7) + 1;
    }

    // Reads the club ID of the logged-in user from the page data embedded by Next.js.
    function findClubId() {
        try {
            const el = document.getElementById('__NEXT_DATA__');
            if (!el) return null;
            const data = JSON.parse(el.textContent);
            // The ID can live in different places depending on the page, so try all of them.
            const candidates = [
                data?.props?.pageProps?.accountProps?.account?.user?.club?.clubId,
                data?.props?.accountProps?.account?.user?.club?.clubId,
                data?.props?.pageProps?.dehydratedState?.queries
                    ?.find((q) => q?.queryKey?.[0] === 'clubs')?.state?.data?.club?.clubId,
            ];
            return candidates.find(Boolean) || null; // first non-empty value, else null
        } catch (err) {
            console.error('Could not read club ID:', err);
            return null;
        }
    }

    // =========================================================
    // 4. Analysis: builds one table row per club member
    // =========================================================

    async function loadMemberRows() {
        const clubId = findClubId();
        if (!clubId) {
            throw new Error('Club-ID nicht gefunden - bitte Seite mit F5 neu laden');
        }

        // Load member list and mission board in parallel.
        const [members, board] = await Promise.all([
            fetchJson(`/api/v4/clubs/${clubId}/members`),
            fetchJson('/api/v4/missions/club/board'),
        ]);

        const boards = board.boards ?? []; // Short form of: board.boards || []

        // ---------------------------------------------------------
        // Step 1: go through all tiles once and collect per-user stats
        // ---------------------------------------------------------
        const statsByUserId = new Map(); // userId -> { claimed, helped, last }
        const emptyStats = () => ({ claimed: 0, helped: 0, last: null });
        // Gets the stats of a user or creates an empty entry on first access.
        const statsOf = (userId) => {
            if (!statsByUserId.has(userId)) statsByUserId.set(userId, emptyStats());
            return statsByUserId.get(userId);
        };

        let lastClaimOverall = null; // newest claim of ANY user (needed for the weekly max below)

        for (const b of boards) {
            for (const tile of b.tiles ?? []) {
                if (!tile) continue;

                // Everyone listed as helper gets +1 "Helped".
                for (const helperId of tile.helpers ?? []) {
                    if (helperId) statsOf(helperId).helped++;
                }

                // Remember the newest claim time across all tiles.
                const claimedAt = parseDate(tile.claimedAt);
                lastClaimOverall = latest(lastClaimOverall, claimedAt);

                // Count the claim for the user who claimed the tile.
                if (!tile.claimedBy) continue;
                const stats = statsOf(tile.claimedBy);
                stats.claimed++;
                stats.last = latest(stats.last, claimedAt); // newest claim of this user
            }
        }

        // ---------------------------------------------------------
        // Step 2: work out the time window of the current mission day
        // ---------------------------------------------------------
        const now = new Date();
        // The API tells us when the next daily reset happens.
        const nextDayStart = parseDate(board.you?.nextDayAt);
        if (!nextDayStart) {
            throw new Error('nextDayAt fehlt in der Board-Antwort');
        }
        // The current mission day started exactly 24h before the next reset.
        const currentDayStart = new Date(nextDayStart.getTime() - DAY_MS);

        // "Low XP phase": from 00:00 UTC until the next reset the daily XP of
        // the new day is not yet credited, so the target is reduced by one day.
        const lowXpPhaseStart = new Date(nextDayStart);
        lowXpPhaseStart.setUTCHours(0, 0, 0, 0);
        const isLowXpPhase = now >= lowXpPhaseStart && now < nextDayStart;

        // ---------------------------------------------------------
        // Step 3: determine the XP a member can reach at most this week
        // ---------------------------------------------------------
        let weeklyMaxXp = WEEKLY_MAX_XP;
        const periodEnd = parseDate(board.periodEnd);

        // If all boards are cleared early, the remaining days no longer give XP.
        // Every day boundary that lies between the last claim and "now"
        // (or the period end, whichever is earlier) costs DAILY_XP.
        if (board.allBoardsCleared && periodEnd && lastClaimOverall && lastClaimOverall < periodEnd) {
            const reference = now < periodEnd ? now : periodEnd;
            // Boundaries are periodEnd - k * DAY, counted if: lastClaim < boundary <= reference
            const lostDays = Math.max(
                0,
                Math.ceil((periodEnd - lastClaimOverall) / DAY_MS) -
                Math.ceil((periodEnd - reference) / DAY_MS)
            );
            weeklyMaxXp = Math.max(0, WEEKLY_MAX_XP - lostDays * DAILY_XP);
        }
        const weeklyXpTarget = weeklyMaxXp - (isLowXpPhase ? DAILY_XP : 0);

        // How many claims a member needs by now (can never exceed the number of boards).
        const requiredClaims = Math.min(expectedClaims(currentDayStart), boards.length);

        // ---------------------------------------------------------
        // Step 4: build one row per member
        // ---------------------------------------------------------
        const rows = members.map((m) => {
            const stats = statsByUserId.get(m.user?.userId) ?? emptyStats();
            const lastActive = parseDate(m.lastActive);
            const weeklyXp = m.weeklyXp ?? 0;
            // Helper for the Yes/No columns.
            const yesNo = (condition) => (condition ? 'Yes' : 'No');
            return {
                User: m.user?.nick || '?',
                'Active Today': yesNo(lastActive && lastActive > currentDayStart),
                'Claimed Today': yesNo(stats.last && stats.last > currentDayStart),
                'Max Claimed': yesNo(stats.claimed >= requiredClaims),
                Claimed: stats.claimed,
                Helped: stats.helped,
                'Weekly XP': weeklyXp,
                'Weekly Max': yesNo(weeklyXp >= weeklyXpTarget),
                _last: stats.last, // internal only, used for sorting (not shown)
            };
        });

        // ---------------------------------------------------------
        // Step 5: default sort order (the first rule that differs wins)
        // ---------------------------------------------------------
        // Rows with 'Yes' in the given column go first
        // (booleans become 0/1 in the subtraction).
        const yesFirst = (field) => (a, b) => (b[field] === 'Yes') - (a[field] === 'Yes');
        // Higher numbers first.
        const highestFirst = (field) => (a, b) => (b[field] ?? 0) - (a[field] ?? 0);
        // Most recent claim first; users without a claim go last.
        const newestClaimFirst = (a, b) => (b._last?.getTime() ?? 0) - (a._last?.getTime() ?? 0);

        const SORT_RULES = [
            yesFirst('Claimed Today'),
            yesFirst('Max Claimed'),
            yesFirst('Weekly Max'),
            yesFirst('Active Today'),
            highestFirst('Helped'),
            newestClaimFirst,
        ];
        rows.sort((a, b) => {
            for (const rule of SORT_RULES) {
                const result = rule(a, b);
                if (result !== 0) return result;
            }
            return 0;
        });
        return rows;
    }

    // =========================================================
    // 5. UI
    // =========================================================
    const COLUMNS = ['User', 'Active Today', 'Claimed Today', 'Claimed', 'Max Claimed', 'Helped', 'Weekly XP', 'Weekly Max'];

    const pad = (n) => String(n).padStart(2, '0'); // 5 -> "05"
    // Date/time as YYYY-MM-DD HH:MM (local time)
    const formatDate = (d) =>
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

    // Turns any cell value into display text.
    // Short form of: if (v instanceof Date) return formatDate(v); if (v == null) return ''; return String(v);
    const formatCell = (v) =>
        v instanceof Date ? formatDate(v) : v == null ? '' : String(v);

    // Injects the CSS for the button and the overlay (once).
    function addStyles() {
        const css = document.createElement('style');
        css.id = 'gcm-style';
        css.textContent = `
            #gcm-btn{position:fixed;bottom:16px;left:16px;z-index:99998;padding:8px 14px;border:0;border-radius:20px;
                background:#7950e5;color:#fff;font:600 13px sans-serif;cursor:pointer;box-shadow:0 2px 8px #0008}
            #gcm-overlay{position:fixed;inset:0;z-index:99999;background:#000a;display:flex;align-items:center;justify-content:center}
            #gcm-box{background:#1a1a2e;color:#eee;border-radius:10px;padding:16px;max-width:95vw;max-height:90vh;overflow:hidden;
                display:flex;flex-direction:column;font:13px sans-serif}
            #gcm-table{overflow:auto;min-height:0;flex:1}
            #gcm-box h2{margin:0 0 10px;font-size:16px;display:flex;justify-content:space-between;gap:16px;align-items:center}
            #gcm-box button{background:#333;color:#eee;border:0;border-radius:6px;padding:4px 10px;cursor:pointer;margin-left:6px}
            #gcm-box table{border-collapse:separate;border-spacing:0;width:100%}
            #gcm-box th,#gcm-box td{padding:5px 10px;border-bottom:1px solid #333;text-align:left;white-space:nowrap}
            #gcm-box th{cursor:pointer;position:sticky;top:0;z-index:3;background:#25254a}
            #gcm-box td.yes{color:#6fdc8c}#gcm-box td.no{color:#ff8a8a}
            #gcm-box th{height:28px;box-sizing:border-box}
            #gcm-box tr.gcm-sum td{font-weight:700;background:#1f1f3d;border-bottom:2px solid #7950e5;position:sticky;top:28px;z-index:2;height:28px;box-sizing:border-box}
        `;
        document.head.appendChild(css);
    }

    // Draws the table into `container`.
    // sortState = { col, dir } where dir is 1 (ascending) or -1 (descending).
    function renderTable(rows, sortState, container) {
        // Sort by the clicked column (if any).
        const { col, dir } = sortState;
        if (col) {
            rows = [...rows].sort((a, b) => {
                const x = a[col] instanceof Date ? a[col].getTime() : a[col];
                const y = b[col] instanceof Date ? b[col].getTime() : b[col];
                if (x == null) return 1;  // empty values always go to the bottom
                if (y == null) return -1;
                return (x > y ? 1 : x < y ? -1 : 0) * dir;
            });
        }

        const table = document.createElement('table');

        // --- Header row: clicking a header sorts by that column ---
        const headRow = table.createTHead().insertRow();
        for (const c of COLUMNS) {
            const th = document.createElement('th');
            th.textContent = c + (sortState.col === c ? (sortState.dir === 1 ? ' ▲' : ' ▼') : '');
            th.onclick = () => {
                // Same column again -> flip direction, new column -> ascending.
                sortState.dir = sortState.col === c ? -sortState.dir : 1;
                sortState.col = c;
                renderTable(rows, sortState, container);
            };
            headRow.appendChild(th);
        }

        // --- Body: one row per member, Yes/No cells get a color class ---
        const body = table.createTBody();
        for (const r of rows) {
            const tr = body.insertRow();
            for (const c of COLUMNS) {
                const td = tr.insertCell();
                td.textContent = formatCell(r[c]);
                if (r[c] === 'Yes') td.className = 'yes';
                if (r[c] === 'No') td.className = 'no';
            }
        }

        // --- Summary row (sticks below the header) ---
        const countYes = (field) => rows.filter((r) => r[field] === 'Yes').length;
        const sum = (field) => rows.reduce((total, r) => total + (Number(r[field]) || 0), 0);
        const totals = {
            User: 'Overview',
            'Active Today': countYes('Active Today'),
            'Claimed Today': countYes('Claimed Today'),
            'Max Claimed': countYes('Max Claimed'),
            Claimed: sum('Claimed'),
            Helped: sum('Helped'),
            'Weekly Max': countYes('Weekly Max'),
        };
        const sumRow = table.tHead.insertRow();
        sumRow.className = 'gcm-sum';
        for (const c of COLUMNS) {
            sumRow.insertCell().textContent = formatCell(totals[c]);
        }

        container.replaceChildren(table);

        // Position the summary row directly below the header
        // (can only be measured once the table is in the DOM).
        const headHeight = table.tHead.rows[0].offsetHeight;
        for (const cell of sumRow.cells) cell.style.top = headHeight + 'px';
    }

    // Opens the overlay with the table, reload button and CSV export.
    async function openPanel() {
        if (document.getElementById('gcm-overlay')) return; // already open

        const overlay = document.createElement('div');
        overlay.id = 'gcm-overlay';
        overlay.innerHTML = `<div id="gcm-box"><h2><span>Weekly Club Missions</span><span>
            <button id="gcm-refresh">Refresh</button><button id="gcm-csv">CSV</button><button id="gcm-close">Close</button></span></h2>
            <div id="gcm-table">Loading…</div></div>`;
        document.body.appendChild(overlay);

        // Close via the button or by clicking on the dark background.
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
        overlay.querySelector('#gcm-close').onclick = () => overlay.remove();

        const container = overlay.querySelector('#gcm-table');
        let currentRows = [];                       // latest loaded data (also used for the CSV)
        const sortState = { col: null, dir: 1 };    // col = null -> keep the default sort order

        // Loads fresh data and draws the table (also used by the Refresh button).
        const load = async () => {
            container.textContent = 'Loading…';
            try {
                currentRows = await loadMemberRows();
                renderTable(currentRows, sortState, container);
            } catch (err) {
                container.textContent = 'Fehler: ' + err.message + ' (bist du eingeloggt und Mitglied im Club?)';
            }
        };

        overlay.querySelector('#gcm-refresh').onclick = load;

        // CSV export: semicolon separated, all cells quoted, BOM so Excel detects UTF-8.
        overlay.querySelector('#gcm-csv').onclick = () => {
            const quote = (v) => `"${formatCell(v).replace(/"/g, '""')}"`; // escape " as ""
            const lines = [COLUMNS.join(';')].concat(
                currentRows.map((r) => COLUMNS.map((c) => quote(r[c])).join(';'))
            );
            const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'club-missions.csv';
            a.click();
            URL.revokeObjectURL(a.href);
        };

        load();
    }

    // =========================================================
    // 6. Button (only shown on the "My club" page)
    // =========================================================

    // Matches /clubs/my, optionally with a language prefix like /en or /pt-BR.
    const isClubPage = () => /^(\/[a-z]{2}(-[A-Za-z]{2,4})?)?\/clubs\/my\/?$/.test(location.pathname);

    // Adds or removes the button depending on the current page.
    function updateButton() {
        const btn = document.getElementById('gcm-btn');
        if (isClubPage()) {
            if (btn) return; // already there
            if (!document.getElementById('gcm-style')) addStyles();
            const b = document.createElement('button');
            b.id = 'gcm-btn';
            b.textContent = 'Club Missions';
            b.onclick = openPanel;
            document.body.appendChild(b);
        } else {
            // Left the club page: clean up button and overlay.
            btn?.remove();
            document.getElementById('gcm-overlay')?.remove();
        }
    }

    // GeoGuessr is a single-page app: page changes do not reload the page.
    // We wrap pushState/replaceState so we get notified about URL changes.
    for (const method of ['pushState', 'replaceState']) {
        const original = history[method];
        history[method] = function () {
            const result = original.apply(this, arguments);
            window.dispatchEvent(new Event('gcm-urlchange'));
            return result;
        };
    }
    window.addEventListener('gcm-urlchange', updateButton);
    window.addEventListener('popstate', updateButton); // browser back/forward
    setInterval(updateButton, 1000);                   // safety net in case an event is missed

    updateButton();
})();