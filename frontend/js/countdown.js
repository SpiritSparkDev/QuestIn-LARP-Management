// Ticks once per second until `targetDate`, calling `render` with the
// remaining time broken into units. Returns a function that stops the timer.
export function startCountdown(targetDate, render, { onComplete } = {}) {
  let done = false;

  function tick() {
    const diff = targetDate.getTime() - Date.now();
    if (diff <= 0) {
      if (!done) {
        done = true;
        render({ days: 0, hours: 0, minutes: 0, seconds: 0, done: true });
        onComplete?.();
      }
      clearInterval(timer);
      return;
    }
    const totalSeconds = Math.floor(diff / 1000);
    render({
      days: Math.floor(totalSeconds / 86400),
      hours: Math.floor((totalSeconds % 86400) / 3600),
      minutes: Math.floor((totalSeconds % 3600) / 60),
      seconds: totalSeconds % 60,
      done: false,
    });
  }

  tick();
  const timer = setInterval(tick, 1000);
  return () => clearInterval(timer);
}
