import { useEffect, useState } from 'react';
import { BookOpen, Download, ExternalLink, FileText } from 'lucide-react';

/** The PDF sits next to index.html (public/). A relative URL keeps it working when the app is hosted in a sub-folder. */
const PDF = './OR-Studio-User-Guide.pdf';
const PDF_NAME = 'OR-Studio-User-Guide.pdf';

/** Can this browser show a PDF inside the page? Phones and some tablets only open it in a separate viewer. */
function canEmbed(): boolean {
  try {
    const nav = navigator as Navigator & { pdfViewerEnabled?: boolean };
    const phone = window.matchMedia('(pointer: coarse)').matches && window.innerWidth < 900;
    return nav.pdfViewerEnabled === true && !phone;
  } catch { return false; }
}

const INSIDE = [
  ['Getting started', 'Open it, install it, use it offline, light and dark theme.'],
  ['The workspace', 'Every part of a solver screen explained with a labelled picture.'],
  ['Thirteen modules, one by one', 'What each solves, how to type your problem, how to read the answer, with a worked example.'],
  ['Learning tools', 'Step player, Tutor mode, Diff mode and the problem library.'],
  ['Save, share, export', 'PDF report, LaTeX, CSV, PNG, share links.'],
  ['Worked walk-throughs', 'A full linear-programming example and the Experiment 10 problems.'],
  ['Glossary and troubleshooting', 'What every short form means, and what to do when something looks wrong.'],
];

/**
 * Is the file at PDF really a PDF? A server that answers unknown paths with the home page (single-page-app fallback)
 * would otherwise make the frame show this app inside itself.
 */
async function pdfExists(): Promise<boolean> {
  try {
    const res = await fetch(PDF, { cache: 'no-cache', headers: { Range: 'bytes=0-7' } });
    if (!res.ok) return false;
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (type.includes('text/html')) return false;
    const head = new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()).slice(0, 5));
    return head === '%PDF-';
  } catch { return false; }
}

export function GuidePage() {
  const [embed] = useState(canEmbed);
  const [loaded, setLoaded] = useState(false);
  const [exists, setExists] = useState<boolean | null>(null);
  useEffect(() => { document.title = 'User guide — OR-Studio'; }, []);
  useEffect(() => { let live = true; void pdfExists().then(ok => { if (live) setExists(ok); }); return () => { live = false; }; }, []);
  return (
    <div className="max-w-[1100px] mx-auto flex flex-col gap-5">
      <div className="titleblock">
        <div className="tb-code" aria-hidden="true"><BookOpen size={26} /></div>
        <div className="tb-cell min-w-0">
          <h1 className="text-[1.6rem] sm:text-[1.9rem] leading-tight font-bold" style={{ letterSpacing: '-0.035em' }}>User guide</h1>
          <p className="text-[0.9rem] muted mt-1.5 max-w-2xl">A complete, plain-language guide to every part of OR/Studio. Read it here or download the PDF.</p>
        </div>
        {exists !== false && (
          <div className="tb-ctl">
            <a className="btn btn-primary" href={PDF} download={PDF_NAME}><Download size={15} /> Download PDF</a>
            <a className="btn" href={PDF} target="_blank" rel="noopener noreferrer"><ExternalLink size={15} /> Open in a new tab</a>
          </div>
        )}
      </div>

      {exists === false ? (
        <section className="card" aria-label="User guide unavailable">
          <div className="card-b flex flex-col gap-3">
            <p className="font-bold text-[1.05rem]">The guide file was not found on this server.</p>
            <p style={{ color: 'var(--text-2)' }}>The PDF is published together with the app. If you are running the app yourself, build the guide with <span className="mono">npm run guide</span> or place <span className="mono">OR-Studio-User-Guide.pdf</span> in the <span className="mono">public</span> folder. The Manual page has the same information in short form.</p>
            <div><a className="btn" href="#/docs"><FileText size={15} /> Open the Manual</a></div>
          </div>
        </section>
      ) : embed && exists === null ? (
        <section className="card" aria-label="Checking the guide"><div className="p-6 text-center muted mono text-[0.85rem]" role="status">CHECKING FOR THE GUIDE…</div></section>
      ) : embed ? (
        <section aria-label="User guide (PDF)" className="card" style={{ minHeight: 640 }}>
          {!loaded && <div className="p-6 text-center muted mono text-[0.85rem]" role="status">LOADING GUIDE…</div>}
          <iframe title="OR/Studio user guide (PDF)" src={`${PDF}#view=FitH&navpanes=0`} onLoad={() => setLoaded(true)} className="w-full block" style={{ height: 'max(640px, calc(100vh - 220px))', border: 0, visibility: loaded ? 'visible' : 'hidden', position: loaded ? 'static' : 'absolute' }} />
          <p className="text-[0.85rem] muted px-4 py-3" style={{ borderTop: '1px solid var(--line)' }}>
            Nothing showing? <a className="underline" href={PDF} target="_blank" rel="noopener noreferrer">Open the guide in a new tab</a> or <a className="underline" href={PDF} download={PDF_NAME}>download it</a>.
          </p>
        </section>
      ) : (
        <section className="card" aria-label="User guide">
          <div className="card-b flex flex-col gap-4">
            <p className="text-[1rem]">Your device opens PDFs in a separate viewer, so the guide cannot be shown inside this page. Tap a button to read it.</p>
            <div className="flex flex-wrap gap-3">
              <a className="btn btn-primary" href={PDF} target="_blank" rel="noopener noreferrer"><FileText size={15} /> Read the guide</a>
              <a className="btn" href={PDF} download={PDF_NAME}><Download size={15} /> Download PDF</a>
            </div>
          </div>
        </section>
      )}

      <section aria-label="What is inside" className="card">
        <header className="card-h"><span>What is inside</span></header>
        <ul className="card-b grid gap-x-8 gap-y-3 md:grid-cols-2">
          {INSIDE.map(([t, d]) => (
            <li key={t}><div className="font-bold">{t}</div><div className="text-[0.92rem]" style={{ color: 'var(--text-2)' }}>{d}</div></li>
          ))}
        </ul>
      </section>
    </div>
  );
}
