// Render a plain-text resume (UPPERCASE section headers, "- " bullets — the
// format the `tailor_resume` Lambda produces) into a clean, modern, single-column
// A4 PDF and trigger a download. Single column + real text keeps it ATS-safe.
// jsPDF is loaded on demand so it stays out of the initial bundle.

const INK   = [17, 24, 39];   // near-black — name, entry titles
const BODY  = [55, 65, 81];   // body text
const MUTED = [107, 114, 128]; // dates, contact
const BRAND = [124, 58, 237]; // section headers, accents

const isSectionHeader = (t) =>
  t === t.toUpperCase() &&
  /[A-Z]/.test(t) &&
  t.replace(/[^A-Za-z]/g, "").length >= 3 &&
  t.length <= 42 &&
  !/^[-•*]/.test(t);

const isContactLine = (t) =>
  t.length <= 130 &&
  /(@|\blinkedin\b|\bgithub\b|\bgitlab\b|https?:\/\/|\+?\d[\d\s().-]{6,})/i.test(t);

// "Frontend Engineer, Acme — 2021–2023"  ->  { left, right }
const splitDate = (t) => {
  const m = t.match(/^(.*\S)\s+[–—|·]\s+([^–—|·]+)$/);
  if (m && /(?:19|20)\d{2}|present|current/i.test(m[2])) {
    return { left: m[1].trim(), right: m[2].trim() };
  }
  return null;
};

const looksLikeEntryTitle = (t) =>
  t.length <= 95 && !/[.:;]$/.test(t) && !/^[-•*]/.test(t);

export async function downloadResumePdf(text, name, fileBase = "tailored") {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const M = 46;                 // side margin
  const CW = pageW - M * 2;     // content width
  const bandH = 84;

  const lines = String(text || "").replace(/\r/g, "").split("\n").map((l) => l.replace(/\s+$/g, ""));

  // Pull the name + a contact line off the top so they can live in the header band.
  let idx = 0;
  while (idx < lines.length && !lines[idx].trim()) idx++;
  let docName = name || "";
  if (!docName && idx < lines.length && !isSectionHeader(lines[idx].trim())) {
    docName = lines[idx].trim();
    idx++;
  } else if (docName && idx < lines.length && lines[idx].trim().toLowerCase() === docName.toLowerCase()) {
    idx++;
  }
  let contact = "";
  while (idx < lines.length && !lines[idx].trim()) idx++;
  if (idx < lines.length && isContactLine(lines[idx].trim())) {
    contact = lines[idx].trim().replace(/\s*[|•]\s*/g, "  ·  ");
    idx++;
  }

  // ── Header band ──
  doc.setFillColor(BRAND[0], BRAND[1], BRAND[2]);
  doc.rect(0, 0, pageW, bandH, "F");
  try {
    if (doc.GState && doc.setGState) {
      doc.setGState(new doc.GState({ opacity: 0.13 }));
      doc.setFillColor(255, 255, 255);
      doc.circle(pageW - 24, 2, 68, "F");
      doc.setGState(new doc.GState({ opacity: 1 }));
    }
  } catch { /* decorative only */ }

  doc.setFont("helvetica", "bold");
  doc.setFontSize(23);
  doc.setTextColor(255, 255, 255);
  doc.text(docName || "Resume", M, contact ? 40 : 50);
  if (contact) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9.5);
    doc.setTextColor(238, 232, 255);
    doc.text(contact, M, 58);
  }

  let y = bandH + 26;
  const ensure = (need) => {
    if (y + need > pageH - M) { doc.addPage(); y = M + 8; }
  };

  let prevWasHeaderOrGap = true;

  for (let i = idx; i < lines.length; i++) {
    const t = lines[i].trim();

    if (!t) { y += 6; prevWasHeaderOrGap = true; continue; }

    if (isSectionHeader(t)) {
      ensure(34);
      y += 12;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10.5);
      doc.setTextColor(BRAND[0], BRAND[1], BRAND[2]);
      doc.text(t.toUpperCase(), M, y, { charSpace: 1.1 });
      y += 6;
      doc.setDrawColor(BRAND[0], BRAND[1], BRAND[2]);
      doc.setLineWidth(1);
      doc.line(M, y, pageW - M, y);
      y += 14;
      prevWasHeaderOrGap = true;
      continue;
    }

    const bullet = t.match(/^[-•*]\s+(.*)$/);
    if (bullet) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9.7);
      doc.setTextColor(BODY[0], BODY[1], BODY[2]);
      const wrapped = doc.splitTextToSize(bullet[1], CW - 16);
      wrapped.forEach((w, k) => {
        ensure(13);
        if (k === 0) {
          doc.setTextColor(BRAND[0], BRAND[1], BRAND[2]);
          doc.text("•", M + 2, y);
          doc.setTextColor(BODY[0], BODY[1], BODY[2]);
        }
        doc.text(w, M + 16, y);
        y += 12.6;
      });
      prevWasHeaderOrGap = false;
      continue;
    }

    // Entry title (job / project / degree) — bold, optional right-aligned date
    if (prevWasHeaderOrGap && looksLikeEntryTitle(t)) {
      ensure(16);
      y += 2;
      const parts = splitDate(t);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10.3);
      doc.setTextColor(INK[0], INK[1], INK[2]);
      if (parts) {
        doc.text(parts.left, M, y);
        doc.setFont("helvetica", "normal");
        doc.setFontSize(9);
        doc.setTextColor(MUTED[0], MUTED[1], MUTED[2]);
        doc.text(parts.right, pageW - M, y, { align: "right" });
      } else {
        doc.text(t, M, y);
      }
      y += 14;
      prevWasHeaderOrGap = false;
      continue;
    }

    // Body paragraph
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9.7);
    doc.setTextColor(BODY[0], BODY[1], BODY[2]);
    doc.splitTextToSize(t, CW).forEach((w) => {
      ensure(13);
      doc.text(w, M, y);
      y += 12.8;
    });
    prevWasHeaderOrGap = false;
  }

  // Footer page numbers (only if it ran to more than one page)
  const pages = doc.internal.getNumberOfPages();
  if (pages > 1) {
    for (let p = 1; p <= pages; p++) {
      doc.setPage(p);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor(MUTED[0], MUTED[1], MUTED[2]);
      doc.text(`${p} / ${pages}`, pageW / 2, pageH - 22, { align: "center" });
    }
  }

  const safe = String(fileBase || "tailored")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  doc.save(`resume-${safe || "tailored"}.pdf`);
}
