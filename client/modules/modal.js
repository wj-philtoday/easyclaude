// ============================================================
// modal — 부모 namespace (core / chat / config)
//   X(Y) := X.Y 스키마. 함수형 dispatcher + 공통
// ============================================================

window.modal = window.modal || function(key) {
  return key == null ? modal : modal[key];
};

// sub: modal.core, modal.chat, modal.config
