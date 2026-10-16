const $ = (id) => document.getElementById(id);
const endpoint = location.origin + '/api/screenshot';

const setStatus = (t, cls = '') => {
  const s = $('status');
  s.className = 'status ' + cls;
  s.textContent = t;
};

$('form').addEventListener('submit', (e) => {
  e.preventDefault();

  const url = $('url').value.trim();
  if (!url) { setStatus('Enter a URL first.', 'err'); return; }

  const src = endpoint + '?' + new URLSearchParams({
    url,
    fullPage: $('full').checked,
    download: 'true',
  });

  const go = $('go');
  const result = $('result');
  go.disabled = true;
  setStatus('Capturing… long pages can take a few seconds.');
  result.hidden = true;

  const img = new Image();

  img.onload = () => {
    go.disabled = false;
    setStatus('Done.', 'ok');

    const head = document.createElement('div');
    head.className = 'head';

    const size = document.createElement('span');
    size.textContent = img.naturalWidth + ' × ' + img.naturalHeight + 'px';

    const dl = document.createElement('a');
    dl.href = src;
    dl.download = 'screenshot.png';
    dl.textContent = 'Download';

    head.append(size, dl);
    result.replaceChildren(head, img);
    result.hidden = false;
    result.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  img.onerror = () => {
    go.disabled = false;
    setStatus('Could not capture that URL — check it is a public http(s) site.', 'err');
  };

  img.src = src;
});
