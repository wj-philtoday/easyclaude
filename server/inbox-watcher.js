'use strict';
// IOA 인박스 watcher — 단말 data_dir의 events-YYYY-MM.jsonl을 watch하고
// 새 줄을 채널 봉투로 변환해 onEvent에 전달한다.
//
// signin/signup tool_result에서 {ioa_id, data_dir}을 감지한 시점에 시작.
// 시작 시점부터의 append만 처리 (과거 이벤트 replay 안 함).
// 월 rotation: 새 events-YYYY-MM.jsonl 생성 시 자동 attach.

const fs = require('fs');
const path = require('path');

function currentEventsFilename(d = new Date()) {
  return `events-${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}.jsonl`;
}

// 배치 유틸 — index.js에서 사용
const BATCH_DELAY_MS = 3000;
const RECAP_DELAY_MS = 5 * 60 * 1000;

const PROCESSED_TS_FILE = 'events-processed-ts.txt';

function readProcessedTs(dataDir) {
  try { return fs.readFileSync(path.join(dataDir, PROCESSED_TS_FILE), 'utf-8').trim(); } catch { return null; }
}
function writeProcessedTs(dataDir, ts) {
  try { fs.writeFileSync(path.join(dataDir, PROCESSED_TS_FILE), ts); } catch {}
}

function makeBatchedEventHandler(selfIoaId, sendFn, dataDir) {
  let buf = [], timer = null;
  function flush() {
    if (!buf.length) return;
    const events = buf.splice(0);
    timer = null;
    // 마지막 처리 timestamp 저장
    const lastTs = events.map(e => e.ts).filter(Boolean).sort().pop();
    if (lastTs && dataDir) writeProcessedTs(dataDir, lastTs);
    let text;
    if (events.length === 1) {
      text = eventToChannelText(events[0], selfIoaId);
    } else {
      const counts = {};
      for (const e of events) { const s = e.source||'ioa'; counts[s]=(counts[s]||0)+1; }
      const summary = Object.entries(counts).map(([k,v])=>`${k} ${v}건`).join(', ');
      const titles = events.map(e=>`• ${e.title||e.type||'(알림)'}`).join('\n');
      text = `<channel source="ioa" ioa_id="${selfIoaId}" from="${selfIoaId}" type="batch">\n알림 ${events.length}건 (${summary}):\n${titles}\n</channel>`;
    }
    console.log(`[inbox-watcher] inject: ${selfIoaId} ${events.length}건`);
    sendFn(text);
  }
  return function handleEvent(event) {
    buf.push(event);
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, BATCH_DELAY_MS);
  };
}

function startWatcher(dataDir, onEvent) {
  const watchers = new Map();   // filename → fs.FSWatcher
  const positions = new Map();  // filename → byte offset

  function watchFile(filename) {
    if (watchers.has(filename)) return;
    const filepath = path.join(dataDir, filename);
    // 시작 시점부터: 현재 파일 크기를 초기 offset으로
    try {
      positions.set(filename, fs.existsSync(filepath) ? fs.statSync(filepath).size : 0);
    } catch {
      positions.set(filename, 0);
    }

    const handler = () => {
      try {
        if (!fs.existsSync(filepath)) return;
        const stat = fs.statSync(filepath);
        const start = positions.get(filename) || 0;
        if (stat.size <= start) return;
        const fd = fs.openSync(filepath, 'r');
        const buf = Buffer.alloc(stat.size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        fs.closeSync(fd);
        positions.set(filename, stat.size);
        const lines = buf.toString('utf8').split('\n').filter(l => l.trim());
        for (const line of lines) {
          try { onEvent(JSON.parse(line)); } catch {}
        }
      } catch {}
    };

    try {
      const w = fs.watch(filepath, { persistent: true }, handler);
      watchers.set(filename, w);
    } catch {
      // 파일이 아직 없으면 dir watcher가 생성 감지 시 다시 시도
    }
  }

  // 현재 월 파일 watch (없어도 dir watch가 잡음)
  watchFile(currentEventsFilename());

  // 디렉토리 watch — 새 월 파일 등장 시 자동 attach
  let dirWatcher = null;
  try {
    dirWatcher = fs.watch(dataDir, { persistent: true }, (eventType, filename) => {
      if (filename && /^events-\d{4}-\d{2}\.jsonl$/.test(filename) && !watchers.has(filename)) {
        watchFile(filename);
      }
    });
  } catch {}

  return function stop() {
    for (const w of watchers.values()) { try { w.close(); } catch {} }
    if (dirWatcher) { try { dirWatcher.close(); } catch {} }
    watchers.clear();
    positions.clear();
  };
}

// events.jsonl 한 줄(BS pushEvent로 append됨) → channel 봉투 텍스트
function eventToChannelText(event, selfIoaId) {
  const from = event.from || selfIoaId;
  const channelType = event.source || 'ioa';
  const body = event.title || event.type || '';
  return `<channel source="ioa" ioa_id="${selfIoaId}" from="${from}" type="${channelType}">\n${body}\n</channel>`;
}

// tool_result line에서 signin/signup response 감지 → {ioa_id, data_dir} 반환 (없으면 null)
function detectAgentIdentity(line) {
  try {
    const obj = JSON.parse(line);
    if (obj.type !== 'user') return null;
    const contents = obj.message && obj.message.content;
    if (!Array.isArray(contents)) return null;
    for (const c of contents) {
      if (!c || c.type !== 'tool_result') continue;
      let text = '';
      if (typeof c.content === 'string') text = c.content;
      else if (Array.isArray(c.content)) {
        for (const item of c.content) {
          if (item && item.type === 'text' && typeof item.text === 'string') text += item.text;
        }
      }
      if (!text) continue;
      try {
        const result = JSON.parse(text);
        if (result && typeof result.ioa_id === 'string' && typeof result.data_dir === 'string') {
          return { ioa_id: result.ioa_id, data_dir: result.data_dir };
        }
      } catch {}
    }
  } catch {}
  return null;
}

module.exports = { startWatcher, eventToChannelText, detectAgentIdentity, makeBatchedEventHandler, readProcessedTs };
