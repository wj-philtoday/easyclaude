# Legacy

EC가 더 이상 사용하지 않지만, 디버그/참고 용도로 보존하는 코드.

- **`ansi.js`** — ANSI escape 시퀀스 처리. tmux/ANSI 파이프라인 시절 사용.
- **`parser.js`** — tmux 화면 파서.
- **`screen.js`** — tmux 화면 추적.

EC v0.3 이후 stream-json 기반으로 전환되며 모두 비활성화. require/import되지 않음.

새 코드에서 참조하지 마세요. 필요하다면 `server/stream-parser.js` (현행 stream-json 파서) 또는 `lexicon.js` (skeleton 분류기) 사용.
