// CLIENT-SIDE report PDF generation. Ports sentinelBuildPDF() from
// assets/js/sentinel-frontend.js: rasterise #pdf-capture with html2canvas, place
// it into a single-page jsPDF sized to the image. Libraries are dynamically
// imported so they never run during SSR.

import type { jsPDF } from 'jspdf';

export async function buildReportPdf(element: HTMLElement): Promise<jsPDF> {
  const html2canvas = (await import('html2canvas')).default;
  const { jsPDF } = await import('jspdf');

  const canvas = await html2canvas(element, {
    scale: 1.5,
    useCORS: true,
    backgroundColor: '#0f1520',
    logging: false,
    windowWidth: 900,
  });

  const imgData = canvas.toDataURL('image/jpeg', 0.85);
  const margin = 10;
  const pdfWidth = 210;
  const usableW = pdfWidth - margin * 2;
  const imgH = (canvas.height * usableW) / canvas.width;
  const pdfHeight = imgH + margin * 2;

  const pdf = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: [pdfWidth, pdfHeight],
    compress: true,
  });
  pdf.addImage(imgData, 'JPEG', margin, margin, usableW, imgH);
  return pdf;
}

export function reportFilename(): string {
  return 'Sentinel-Report-' + new Date().toISOString().slice(0, 10) + '.pdf';
}
