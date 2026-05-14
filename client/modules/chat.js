// ============================================================
// chat — 부모 namespace (message / input / info)
//   X(Y) := X.Y 스키마. 함수형 dispatcher + 공통
// ============================================================

window.chat = window.chat || function(key) {
  return key == null ? chat : chat[key];
};

// sub: chat.message, chat.input, chat.info
