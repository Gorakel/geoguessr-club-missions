// ==UserScript==
// @name         LOCAL - GeoGuessr Weekly Club Mission Overview
// @namespace    https://www.geoguessr.com/
// @version      1.6
// @description  Shows current status of the weekly mission progress per member
// @match        https://www.geoguessr.com/*
// @grant        none
// @license      MIT
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // =========================================================
    // 1. Settings
    // =========================================================
    const WEEKLY_MAX_XP = 280;
    const DAILY_XP = 20;
    // const RESET_HOUR = 13; // Tageswechsel um 13:00 Uhr (lokale Zeit)
    // const LOW_START_HOUR = 1;

    // =========================================================
    // 2. API-Access (Session-Cookie of the browser)
    // =========================================================
    async function getJson(path) {
        const res = await fetch(path, {
            credentials: 'include',
            headers: { Accept: 'application/json' },
        });
        if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
        return res.json();
    }

    // =========================================================
    // 3. Analysis
    // =========================================================
    function parseDate(value) {
        if (!value) return null;
        const d = new Date(value);
        return isNaN(d) ? null : d;
    }

    // function getStichtag(now) {
    //     const s = new Date(now);
    //     s.setHours(RESET_HOUR, 0, 0, 0);
    //     if (now < s) s.setDate(s.getDate() - 1);
    //     return s;
    // }

    // function expectedClaims(now) {
    //     const shifted = new Date(now.getTime() - RESET_HOUR * 3600 * 1000);
    //     const dowMonday0 = (shifted.getDay() + 6) % 7; // Mo=0 ... So=6
    //     return ((dowMonday0 + 5) % 7) + 1;
    // }
    function expectedClaims(lastReset) {
        const dowMonday0 = (lastReset.getDay() + 6) % 7; // Mo=0 ... So=6
        return ((dowMonday0 + 5) % 7) + 1;
    }

    function getClubId() {
        try {
            const el = document.getElementById('__NEXT_DATA__');
            if (!el) return null;
            const data = JSON.parse(el.textContent);
            const candidates = [
                data?.props?.pageProps?.accountProps?.account?.user?.club?.clubId,
                data?.props?.accountProps?.account?.user?.club?.clubId,
                data?.props?.pageProps?.dehydratedState?.queries
                    ?.find((q) => q?.queryKey?.[0] === 'clubs')?.state?.data?.club?.clubId,
            ];
            return candidates.find(Boolean) || null;
        } catch (err) {
            console.error('Club-ID konnte nicht gelesen werden:', err);
            return null;
        }
    }

    async function loadData() {
        const clubId = getClubId();
        if (!clubId) {
            throw new Error('Club-ID nicht gefunden - bitte Seite mit F5 neu laden');
        }

        const [members, board] = await Promise.all([
            getJson(`/api/v4/clubs/${clubId}/members`),
            getJson('/api/v4/missions/club/board'),
        ]);

        // const newEntry = () => ({ claimed: 0, completed: 0, helped: 0, last: null });
        const newEntry = () => ({ claimed: 0, helped: 0, last: null });
        const byUser = new Map();
        for (const b of board.boards || []) {
            for (const tile of b.tiles || []) {
                if (!tile) continue;

                // Helpers: every user listed in tile.helpers gets +1 "Helped"
                for (const helperId of tile.helpers || []) {
                    if (!helperId) continue;
                    const h = byUser.get(helperId) || newEntry();
                    h.helped++;
                    byUser.set(helperId, h);
                }

                if (!tile.claimedBy) continue;
                const e = byUser.get(tile.claimedBy) || newEntry();
                e.claimed++;
                // if (tile.completed === true) e.completed++;
                const t = parseDate(tile.claimedAt);
                if (t && (!e.last || t > e.last)) e.last = t;
                byUser.set(tile.claimedBy, e);
            }
        }

        const now = new Date();
        // let nextReset = parseDate(board.you?.nextDayAt);
        const nextReset = parseDate(board.you?.nextDayAt);
        // if (!nextReset) {
        //     nextReset = new Date(now);
        //     nextReset.setHours(RESET_HOUR, 0, 0, 0);
        //     if (nextReset <= now) nextReset.setDate(nextReset.getDate() + 1);
        // }
        if (!nextReset) {
            throw new Error('nextDayAt fehlt in der Board-Antwort');
        }
        // const stichtag = getStichtag(now);
        const stichtag = new Date(nextReset.getTime() - 24 * 3600 * 1000);
        // const hour = now.getHours();
        // const lowPhase = hour >= LOW_START_HOUR && hour < RESET_HOUR;
        const lowStart = new Date(nextReset);
        // lowStart.setHours(LOW_START_HOUR, 0, 0, 0);
        lowStart.setUTCHours(0, 0, 0, 0);
        const lowPhase = now >= lowStart && now < nextReset;
        const weeklyMax = WEEKLY_MAX_XP - (lowPhase ? DAILY_XP : 0);
        const boardCount = (board.boards || []).length;
        // const needed = Math.min(expectedClaims(now), boardCount);
        const needed = Math.min(expectedClaims(stichtag), boardCount);

        const rows = members.map((m) => {
            const userId = m.user && m.user.userId;
            const agg = byUser.get(userId) || newEntry();
            return {
                User: (m.user && m.user.nick) || '?',
                'Active Today': (() => {
                    const la = parseDate(m.lastActive);
                    return la && la > stichtag ? 'Yes' : 'No';
                })(),
                'Claimed Today': agg.last && agg.last > stichtag ? 'Yes' : 'No',
                'Max Claimed': needed <= agg.claimed ? 'Yes' : 'No',
                Claimed: agg.claimed,
                // Completed: agg.completed,
                Helped: agg.helped,
                'Weekly XP': m.weeklyXp ?? 0,
                'Weekly Max': (m.weeklyXp ?? 0) >= weeklyMax ? 'Yes' : 'No',
                _last: agg.last,
            };
        });

        const yesFirst = (field) => (a, b) =>
            (b[field] === 'Yes') - (a[field] === 'Yes');
        const noFirst = (field) => (a, b) =>
            (b[field] === 'No') - (a[field] === 'No');
        const byLastClaim = (a, b) =>
            (b._last?.getTime() ?? -Infinity) - (a._last?.getTime() ?? -Infinity);
        const highestFirst = (field) => (a, b) => (b[field] ?? 0) - (a[field] ?? 0);
        const SORT_ORDER = [
            yesFirst('Claimed Today'),
            // noFirst('Claimed Today'),
            yesFirst('Max Claimed'),
            yesFirst('Weekly Max'),
            yesFirst('Active Today'),
            highestFirst('Helped'),
            byLastClaim,
        ];
        rows.sort((a, b) => {
            for (const cmp of SORT_ORDER) {
                const r = cmp(a, b);
                if (r !== 0) return r;
            }
            return 0;
        });
        return rows;
    }

    // =========================================================
    // 4. UI
    // =========================================================
    // const COLUMNS = ['User', 'Active Today', 'Claimed Today', 'Max Claimed', 'Claimed', 'Completed', 'Helped', 'Weekly XP', 'Weekly Max'];
    const COLUMNS = ['User', 'Active Today', 'Claimed Today', 'Claimed', 'Max Claimed', 'Helped', 'Weekly XP', 'Weekly Max'];

    const pad = (n) => String(n).padStart(2, '0');
    // Date/Time as YYYY-MM-DD HH:MM (local time)
    const fmtDate = (d) =>
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

    const fmt = (v) =>
        v instanceof Date ? fmtDate(v) : v == null ? '' : String(v);

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

    function renderTable(rows, state, tableWrap) {
        const { col, dir } = state;
        if (col) {
            rows = [...rows].sort((a, b) => {
                const x = a[col] instanceof Date ? a[col].getTime() : a[col];
                const y = b[col] instanceof Date ? b[col].getTime() : b[col];
                if (x == null) return 1;
                if (y == null) return -1;
                return (x > y ? 1 : x < y ? -1 : 0) * dir;
            });
        }
        const table = document.createElement('table');
        const head = table.createTHead().insertRow();
        for (const c of COLUMNS) {
            const th = document.createElement('th');
            th.textContent = c + (state.col === c ? (state.dir === 1 ? ' ▲' : ' ▼') : '');
            th.onclick = () => {
                state.dir = state.col === c ? -state.dir : 1;
                state.col = c;
                renderTable(rows, state, tableWrap);
            };
            head.appendChild(th);
        }
        const body = table.createTBody();
        for (const r of rows) {
            const tr = body.insertRow();
            for (const c of COLUMNS) {
                const td = tr.insertCell();
                td.textContent = fmt(r[c]);
                if (r[c] === 'Yes') td.className = 'yes';
                if (r[c] === 'No') td.className = 'no';
            }
        }

        const countYes = (field) => rows.filter((r) => r[field] === 'Yes').length;
        const sum = (field) => rows.reduce((s, r) => s + (Number(r[field]) || 0), 0);
        const totals = {
            User: 'Overview',
            'Active Today': countYes('Active Today'),
            'Claimed Today': countYes('Claimed Today'),
            'Max Claimed': countYes('Max Claimed'),
            Claimed: sum('Claimed'),
            // Completed: sum('Completed'),
            Helped: sum('Helped'),
            'Weekly Max': countYes('Weekly Max'),
        };
        const sumRow = table.tHead.insertRow();
        sumRow.className = 'gcm-sum';
        for (const c of COLUMNS) {
            sumRow.insertCell().textContent = fmt(totals[c]);
        }

        tableWrap.replaceChildren(table);


        const headHeight = table.tHead.rows[0].offsetHeight;
        for (const cell of sumRow.cells) cell.style.top = headHeight + 'px';
    }

    async function openPanel() {
        if (document.getElementById('gcm-overlay')) return;
        const overlay = document.createElement('div');
        overlay.id = 'gcm-overlay';
        overlay.innerHTML = `<div id="gcm-box"><h2><span>Weekly Club Missions</span><span>
            <button id="gcm-refresh">Refresh</button><button id="gcm-csv">CSV</button><button id="gcm-close">Close</button></span></h2>
            <div id="gcm-table">Loading…</div></div>`;
        document.body.appendChild(overlay);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
        overlay.querySelector('#gcm-close').onclick = () => overlay.remove();

        const wrap = overlay.querySelector('#gcm-table');
        let current = [];
        const state = { col: null, dir: 1 };

        const load = async () => {
            wrap.textContent = 'Loading…';
            try {
                current = await loadData();
                renderTable(current, state, wrap);
            } catch (err) {
                wrap.textContent = 'Fehler: ' + err.message + ' (bist du eingeloggt und Mitglied im Club?)';
            }
        };

        overlay.querySelector('#gcm-refresh').onclick = load;
        overlay.querySelector('#gcm-csv').onclick = () => {
            const lines = [COLUMNS.join(';')].concat(
                current.map((r) => COLUMNS.map((c) => `"${fmt(r[c]).replace(/"/g, '""')}"`).join(';'))
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
    // 5. Button
    // =========================================================
    const isTargetPage = () => /^(\/[a-z]{2}(-[A-Za-z]{2,4})?)?\/clubs\/my\/?$/.test(location.pathname);

    function updateButton() {
        const btn = document.getElementById('gcm-btn');
        if (isTargetPage()) {
            if (btn) return;
            if (!document.getElementById('gcm-style')) addStyles();
            const b = document.createElement('button');
            b.id = 'gcm-btn';
            b.textContent = 'Club Missions';
            b.onclick = openPanel;
            document.body.appendChild(b);
        } else {
            if (btn) btn.remove();
            const overlay = document.getElementById('gcm-overlay');
            if (overlay) overlay.remove();
        }
    }

    for (const method of ['pushState', 'replaceState']) {
        const original = history[method];
        history[method] = function () {
            const result = original.apply(this, arguments);
            window.dispatchEvent(new Event('gcm-urlchange'));
            return result;
        };
    }
    window.addEventListener('gcm-urlchange', updateButton);
    window.addEventListener('popstate', updateButton);
    setInterval(updateButton, 1000);

    updateButton();
})();