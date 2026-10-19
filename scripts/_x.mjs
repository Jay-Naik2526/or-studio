import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true, pipe: true, args: ['--no-sandbox','--disable-gpu'] });
const p = await b.newPage(); await p.setViewport({ width: 1280, height: 900 });
await p.goto('http://127.0.0.1:4610/', { waitUntil: 'load' });
await p.evaluate(() => { localStorage.clear(); localStorage.setItem('or_theme','light'); });
for (const id of process.argv.slice(2)) {
  const [m, lib] = id.split(':');
  await p.goto(`http://127.0.0.1:4610/#/m/${m}?lib=${lib}`, { waitUntil: 'load' }); await p.reload({ waitUntil: 'load' }); await new Promise(r => setTimeout(r, 1200));
  console.log('####', id, await p.evaluate(() => { const s = document.querySelector('section[aria-label=Model]'); const v=[...document.querySelectorAll('[aria-label=Method] button,[aria-label=Mode] button')].map(x=>x.textContent.trim()).join('/'); return v+' ## '+s.innerText.replace(/\n+/g, ' | ').slice(0,1100); }));
}
await b.close();
