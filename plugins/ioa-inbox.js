'use strict';
// EC 플러그인: IOA inbox watcher
// IOA 에이전트의 events JSONL을 감시해 새 이벤트를 claude stdin으로 주입.
// IOA를 사용하지 않는 경우 이 파일을 삭제하거나 plugins/ 에서 제거.

const { startWatcher, eventToChannelText, detectAgentIdentity } = require('../server/inbox-watcher');

let ec = null; // EC API 참조

module.exports = {
  // ── EC 플러그인 인터페이스 ─────────────────────────────────────────────────

  onLoad(ecApi) {
    ec = ecApi;
    console.log('[plugin:ioa-inbox] loaded');
  },

  // 세션 spawn 시 — state.json 또는 마커 파일에서 watcher 복원
  onSessionSpawn(ch, sess) {
    const fs2 = require('fs');
    fs2.appendFileSync(`${process.env.HOME}/tmp/watcher-trigger.log`, `[onSessionSpawn] ${sess.id} ts=${Date.now()}\n`);
    const st = ec.sessionState[sess.id];
    // 1) sessionState에서 복원
    if (st?.signedInAs && st?.inboxDataDir) {
      if (ch.signedInAs === st.signedInAs && ch.inboxStop) return;
      _startWatcher(ch, { ioa_id: st.signedInAs, data_dir: st.inboxDataDir });
      if (st.lastEventTs) ch._lastEventTs = st.lastEventTs;
      console.log(`[plugin:ioa-inbox] restored from state: ${sess.id} → ${st.signedInAs}`);
      return;
    }
    // 2) overlay home의 마커 파일에서 복원 (auto-signin 후 ioa-mcp.ts가 기록)
    const home = sess.home;
    if (!home) return;
    const fs = require('fs');
    const path = require('path');
    // home 하위 ioa/**/.ec-identity.json 탐색
    try {
      const ioaDir = path.join(home, 'ioa');
      if (!fs.existsSync(ioaDir)) return;
      const entries = fs.readdirSync(ioaDir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const markerPath = path.join(ioaDir, e.name, '.ec-identity.json');
        if (!fs.existsSync(markerPath)) continue;
        const identity = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
        if (!identity.ioa_id || !identity.data_dir) continue;
        _startWatcher(ch, identity);
        ec.sessionState[sess.id] = ec.sessionState[sess.id] || {};
        ec.sessionState[sess.id].signedInAs   = identity.ioa_id;
        ec.sessionState[sess.id].inboxDataDir = identity.data_dir;
        ec.saveState(ec.sessionState);
        console.log(`[plugin:ioa-inbox] restored from marker: ${sess.id} → ${identity.ioa_id}`);
        return;
      }
    } catch (e) {
      console.warn('[plugin:ioa-inbox] marker scan error:', e.message);
    }
  },

  // stdout 한 줄마다 — signin tool_result 감지 → watcher 설정
  onStdoutLine(ch, line) {
    const identity = detectAgentIdentity(line);
    if (!identity) return;
    require('fs').appendFileSync(`${process.env.HOME}/tmp/watcher-trigger.log`, `[onStdoutLine] ${ch.sess?.id} ioa=${identity.ioa_id} ts=${Date.now()}\n`);
    if (ch.signedInAs === identity.ioa_id && ch.inboxStop) return;
    if (ch.inboxStop) { try { ch.inboxStop(); } catch {} ch.inboxStop = null; }
    _startWatcher(ch, identity);
    // 영속
    ec.sessionState[ch.sess.id] = ec.sessionState[ch.sess.id] || {};
    ec.sessionState[ch.sess.id].signedInAs   = identity.ioa_id;
    ec.sessionState[ch.sess.id].inboxDataDir = identity.data_dir;
    ec.saveState(ec.sessionState);
    console.log(`[plugin:ioa-inbox] watcher: ${ch.sess.id} → ${identity.ioa_id}`);
  },

  // 세션 종료 시 — watcher 정리
  onSessionExit(ch) {
    if (ch.inboxStop) {
      try { ch.inboxStop(); } catch {}
      ch.inboxStop = null;
      ch.signedInAs = null;
    }
  },
};

// ── 내부 헬퍼 ───────────────────────────────────────────────────────────────

function _startWatcher(ch, identity) {
  ch.signedInAs = identity.ioa_id;
  const lastTs = ch._lastEventTs || ec.sessionState[ch.sess?.id]?.lastEventTs || null;
  ch.inboxStop = startWatcher(identity.data_dir, lastTs, (event) => {
    if (event.ts) {
      ec.sessionState[ch.sess.id] = ec.sessionState[ch.sess.id] || {};
      ec.sessionState[ch.sess.id].lastEventTs = event.ts;
      ec.saveState(ec.sessionState);
    }
    const text = eventToChannelText(event, identity.ioa_id);
    if (!text) return; // 필터됨 (bs.restarted 등)
    console.log(`[plugin:ioa-inbox] event→inject: ${ch.sess.id} alive=${ch.alive} type=${event.type} text_len=${text?.length}`);
    // alive=false여도 sendUserText가 내부에서 재spawn 처리함
    ec.sendUserText(ch, text);
  });
}
