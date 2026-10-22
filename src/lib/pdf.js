'use strict';
const PDFDocument = require('pdfkit');
const { fmtMinutes } = require('./helpers');

const INK = '#23302a', MUTED = '#6b766f', LINE = '#d9d2c4', GREEN = '#2f6b4f', SOFT = '#eef3ef';

function fmtDate(iso) {
  return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}
function fmtTime(ts, tz) {
  return new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz });
}

/**
 * Streams a PDF of a report (from lib/reports.buildReport) to `res`.
 * Layout: title block → summary → one section per animal, each with a
 * day-by-day table: time · activity · minutes · staff · notes.
 */
function writeReportPdf(report, res, { generatedBy }) {
  const doc = new PDFDocument({ size: 'LETTER', margin: 48, bufferPages: true, info: { Title: 'FairyHale Kennel activity report', Author: 'FairyHale Kennel Management' } });
  doc.pipe(res);

  const pageW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const left = doc.page.margins.left;
  const bottom = () => doc.page.height - doc.page.margins.bottom;
  const ensure = (h) => { if (doc.y + h > bottom()) doc.addPage(); };

  // ---- Title ----
  doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(20).text('FairyHale Kennel', left, doc.y);
  doc.fillColor(INK).fontSize(14).text(report.animal ? `Activity report — ${report.animal.name}` : 'Activity report — all animals');
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(10).fillColor(MUTED)
    .text(`${fmtDate(report.from)} to ${fmtDate(report.to)}  ·  times shown in ${report.timezone}`)
    .text(`Generated ${new Date().toLocaleString('en-US', { timeZone: report.timezone })} by ${generatedBy}`);
  if (report.animal) {
    doc.text(`${report.animal.animal_type}${report.animal.breed ? ' · ' + report.animal.breed : ''}`);
  }
  doc.moveDown(0.6);
  hr();

  // ---- Summary ----
  doc.moveDown(0.5);
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(12).text('Summary');
  doc.moveDown(0.2);
  doc.font('Helvetica').fontSize(10);
  const t = report.totals;
  doc.text(`Total time: ${fmtMinutes(t.minutes)}   ·   Entries: ${t.entries}   ·   Days with activity: ${t.days}${report.animal ? '' : `   ·   Animals: ${t.animals}`}`);
  if (!report.animal && report.animals.length) {
    doc.moveDown(0.4);
    table(['Animal', 'Type', 'Days', 'Entries', 'Time'], report.animals.map((a) => [a.name, a.animal_type, String(a.days.length), String(a.entries), fmtMinutes(a.minutes)]), [0.34, 0.22, 0.12, 0.14, 0.18], { numeric: [2, 3, 4] });
  }

  if (!report.animals.length) {
    doc.moveDown(1);
    doc.fillColor(MUTED).text('No activity was logged in this period.');
    return finish();
  }

  // ---- Per animal ----
  for (const animal of report.animals) {
    ensure(90);
    doc.moveDown(0.9);
    doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(13).text(animal.name, { continued: true })
      .fillColor(MUTED).font('Helvetica').fontSize(10).text(`   ${animal.animal_type}${animal.breed ? ' · ' + animal.breed : ''}`);
    doc.fillColor(INK).fontSize(10).text(`${fmtMinutes(animal.minutes)} over ${animal.entries} entr${animal.entries === 1 ? 'y' : 'ies'} on ${animal.days.length} day${animal.days.length === 1 ? '' : 's'}  ·  ` +
      animal.byType.map((b) => `${b.type} ${fmtMinutes(b.minutes)}`).join(', '));
    doc.moveDown(0.3);

    for (const day of animal.days) {
      ensure(48);
      doc.moveDown(0.3);
      doc.rect(left, doc.y - 2, pageW, 16).fill(SOFT);
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(10).text(fmtDate(day.date), left + 6, doc.y, { continued: true, width: pageW - 12 })
        .font('Helvetica').fillColor(MUTED).text(`${fmtMinutes(day.minutes)} · ${day.entries.length} entr${day.entries.length === 1 ? 'y' : 'ies'}`, { align: 'right' });
      doc.moveDown(0.25);
      table(['Time', 'Activity', 'Duration', 'Staff', 'Notes'],
        day.entries.map((e) => [fmtTime(e.performed_at, report.timezone), e.activity_type, fmtMinutes(e.duration_minutes), e.user_name, e.notes || '']),
        [0.11, 0.21, 0.11, 0.17, 0.40], { numeric: [2], header: false });
    }
  }
  return finish();

  // ---- helpers ----
  function hr() { doc.moveTo(left, doc.y).lineTo(left + pageW, doc.y).strokeColor(LINE).lineWidth(0.5).stroke(); }

  function table(headers, rows, widths, { numeric = [], header = true } = {}) {
    const cols = widths.map((w) => Math.floor(w * pageW));
    const xs = cols.reduce((acc, w, i) => { acc.push(i ? acc[i - 1] + cols[i - 1] : left); return acc; }, []);
    const pad = 4;
    const rowH = (cells, size) => Math.max(...cells.map((c, i) => doc.fontSize(size).heightOfString(String(c), { width: cols[i] - pad * 2 }))) + pad * 2;

    const drawRow = (cells, { bold = false, size = 9, color = INK } = {}) => {
      const h = rowH(cells, size);
      ensure(h + 2);
      const y = doc.y;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(color);
      cells.forEach((c, i) => doc.text(String(c), xs[i] + pad, y + pad, { width: cols[i] - pad * 2, align: numeric.includes(i) ? 'right' : 'left' }));
      doc.y = y + h;
      doc.moveTo(left, doc.y).lineTo(left + pageW, doc.y).strokeColor(LINE).lineWidth(0.3).stroke();
    };
    if (header) drawRow(headers, { bold: true, size: 8, color: MUTED });
    rows.forEach((r) => drawRow(r));
    doc.x = left;
  }

  function finish() {
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.font('Helvetica').fontSize(8).fillColor(MUTED)
        .text(`FairyHale Kennel · activity report · page ${i + 1} of ${range.count}`, left, doc.page.height - 32, { width: pageW, align: 'center', lineBreak: false });
    }
    doc.end();
  }
}

module.exports = { writeReportPdf };
