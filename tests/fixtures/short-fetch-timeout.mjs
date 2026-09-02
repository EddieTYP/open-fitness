const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);

Object.defineProperty(AbortSignal, "timeout", {
  configurable: true,
  value(delay) {
    return nativeTimeout(Math.min(delay, 1_000));
  },
});
