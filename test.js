// Smoke test: exercises the SSRF guard and a real full-page capture.
const fs = require('fs');
const { capture, parseOpts, assertPublicUrl } = require('./server');

(async () => {
  let pass = true;

  // 1) SSRF guard must block localhost / private ranges (no DNS needed for IP literals).
  for (const bad of ['http://127.0.0.1', 'http://169.254.169.254/latest/meta-data', 'http://10.0.0.5']) {
    try { await assertPublicUrl(bad); console.log('FAIL (not blocked):', bad); pass = false; }
    catch { console.log('blocked ok:', bad); }
  }

  // 2) Real full-page capture.
  const opts = parseOpts({ fullPage: 'true', width: '1440' });
  const { buffer, height, stitched } = await capture('https://example.com', opts);
  fs.writeFileSync('/scratch/work/api_test_out.png', buffer);
  console.log(`captured ${buffer.length} bytes, height=${height}, stitched=${stitched}`);
  if (buffer.length < 1000) pass = false;

  console.log(pass ? 'PASS' : 'FAIL');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
