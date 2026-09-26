/**
 * Tính timestamp (ms) của nửa đêm Pacific Time (America/Los_Angeles) kế tiếp,
 * tính từ nowMs. Gemini free-tier reset quota theo PT.
 * @param {number} nowMs
 * @returns {number} timestamp ms
 */
function zonedTimeToUtcMs(year, month, day, hour, minute, second, timeZone) {
  // Thuật toán: đoán UTC = Date.UTC(...), rồi hiệu chỉnh bằng offset thực tế.
  // Lặp 2 lần để hội tụ qua biên DST.
  let guess = Date.UTC(year, month - 1, day, hour, minute, second);
  for (let i = 0; i < 3; i++) {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hour12: false,
    });
    const parts = Object.fromEntries(
      fmt.formatToParts(new Date(guess)).map((p) => [p.type, p.value])
    );
    const asUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      parts.hour === '24' ? 0 : Number(parts.hour),
      Number(parts.minute),
      Number(parts.second)
    );
    const diff = asUtc - guess;
    // diff chính là (giờ wall-clock tại guess theo TZ) - guess.
    // Muốn wall-clock == target thì guess mới = guess - diff... kiểm tra dấu:
    // target wall = Date.UTC(y,m,d,H,...). Ta có wall(guess) = guess + offset(guess).
    // Muốn wall(guess) == target => guess = target - offset.
    // Mà diff = wall(guess) - guess = offset(guess) => guess_new = target - diff.
    const target = Date.UTC(year, month - 1, day, hour, minute, second);
    const next = target - diff;
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

function getPtDateParts(nowMs) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(new Date(nowMs)).map((p) => [p.type, p.value])
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
  };
}

/** @returns {number} timestamp (ms) của nửa đêm PT kế tiếp tính từ nowMs */
function nextMidnightPacific(nowMs) {
  const { year, month, day } = getPtDateParts(nowMs);
  // Nửa đêm của "ngày mai" theo giờ PT.
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + 1);
  return zonedTimeToUtcMs(
    d.getUTCFullYear(),
    d.getUTCMonth() + 1,
    d.getUTCDate(),
    0, 0, 0,
    'America/Los_Angeles'
  );
}

module.exports = { nextMidnightPacific, zonedTimeToUtcMs };
