// Extracts plain text from a PDF File object using PDF.js.
// Runs entirely in the browser — no server needed for this step.
// Up to 6 pages are processed (covers any typical CV/resume).

import * as pdfjsLib from "pdfjs-dist";
// Import the worker directly from the installed package so Vite bundles it
// locally — avoids CDN version-mismatch issues (cdnjs lags behind npm).
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export async function extractPDFText(file) {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  let fullText = "";
  const pagesToRead = Math.min(pdf.numPages, 6);

  for (let i = 1; i <= pagesToRead; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    // Join items with spaces; preserve line breaks between items
    const pageText = content.items.map((item) => item.str).join(" ");
    fullText += pageText + "\n\n";
  }

  return fullText.trim();
}
