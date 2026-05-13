'use strict';
// EC 플러그인: IOA inbox watcher
// IOA 에이전트의 events JSONL을 감시해 새 이벤트를 claude stdin으로 주입.
// IOA를 사용하지 않는 경우 이 파일을 삭제하거나 plugins/ 에서 제거.

const { startWatcher, eventToChannelText, detectAgentIdentity } = require('../inbox-watcher');

let ec = null; // EC API 참조

module.exports = {
  // ── EC 플러그인 인터페이스 ─────────────────────────────────────────────────

  onLoad(ecApi) {
    ec = ecApi;
    console.log('[plugin:ioa-inbox] loaded');
  },

  // 세션 spawn 시 — state.json에 signedInAs 있으면 watcher 즉시 복원
  onSessionSpawn(ch, sess) {
    const st = ec.sessionState[sess.id];
    if (!st?.signedInAs || !st?.inboxDataDir) return;
    if (ch.signedInAs === st.signedInAs && ch.inboxStop) return;
    _startWatcher(ch, { ioa_id: st.signedInAs, data_dir: st.inboxDataDir });
    if (st.lastEventTs) ch._lastEventTs = st.lastEventTs; // catch-up용
    console.log(`[plugin:ioa-inbox] restored watcher: ${sess.id} → ${st.signedInAs}`);
    // EC 재시작 신호
    setTimeout(() => {
      const msg = `<channel source="ioa" ioa_id="${st.signedInAs}" from="system" type="restart">\nEC 서버가 재시작됐습니다. 하던 업무를 이어서 진행하세요.\n</channel>`;
      ec.sendUserText(ch, msg);
      console.log(`[plugin:ioa-inbox] restart signal → ${st.signedInAs}`);
    }, 2000);
  },

  // stdout 한 줄마다 — signin tool_result 감지 → watcher 설정
  onStdoutLine(ch, line) {
    const identity = detectAgentIdentity(line);
    if (!identity) return;
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
  ch.inboxStop = startWatcher(identity.data_dir, (event) => {
    if (event.ts) {
      ec.sessionState[ch.sess.id] = ec.sessionState[ch.sess.id] || {};
      ec.sessionState[ch.sess.id].lastEventTs = event.ts;
      ec.saveState(ec.sessionState);
    }
    ec.sendUserText(ch, eventToChannelText(event, identity.ioa_id));
  });
}
