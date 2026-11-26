/**
 * A real touch drag that LIFTS WHILE MOVING, so Chromium's compositor keeps scrolling on momentum after the finger is
 * gone (the phone case). Shared by the phone history-scroll matrix and the stale-window spec.
 * `direction` 1 = finger moves DOWN the screen (older rows are revealed), -1 = UP (newer rows).
 * `speed` is px/s at ~60 Hz move events.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function fling(cdp, box, distance, speed, direction = 1) {
  const x = box.x + box.width / 2;
  const perStep = Math.max(6, Math.round(speed / 60));
  const steps = Math.max(4, Math.round(distance / perStep));
  const yMin = box.y + box.height * 0.1;
  const yMax = box.y + box.height * 0.9;
  let y = direction === 1 ? box.y + box.height * 0.15 : box.y + box.height * 0.85;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 0; i < steps; i += 1) {
    y = direction === 1 ? Math.min(yMax, y + perStep) : Math.max(yMin, y - perStep);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
    await sleep(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
