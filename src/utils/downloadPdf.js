import html2canvas from 'html2canvas';
import { jsPDF } from 'jspdf';

/**
 * সরাসরি PDF ডাউনলোড — প্রিন্ট ডায়ালগ ছাড়া।
 *
 * `window.print()` শুধু প্রিন্ট ডায়ালগ খোলে — সেখান থেকে "Save as PDF" বাছতে হয়।
 * এই ইউটিলিটি `.print-sheet` এলিমেন্টগুলোকে html2canvas দিয়ে ছবি বানিয়ে jsPDF-এ
 * A4 পেজে বসায় (০.৭৫ ইঞ্চি = ১৯.০৫ মিমি মার্জিন, print.css-এর @page নিয়মের সমান)
 * এবং ব্রাউজারের ডাউনলোড ট্রিগার করে — কোনো ডায়ালগ খোলে না।
 *
 * - ১টি/পেজ লেআউট: প্রতি শিট পুরো A4 পেজ ভরে (print.css-এর print-single নিয়ম)।
 * - ২টি/পেজ লেআউট: প্রতি A4 পেজে ২টি শিট, উপর-নিচে অর্ধেক-অর্ধেক করে
 *   (print.css-এর print-pair নিয়ম — compact শিটের উচ্চতা ১২৯.৪ মিমি)।
 *
 * দুটি সীমা জেনে রাখা ভালো:
 * - QR কোড `QRCodeSVG` (ইনলাইন SVG) — html2canvas SVG আঁকতে পারে না, তাই ক্যাপচারের
 *   আগে `onclone`-এ প্রতিটি SVG-কে একই মাপের `<img>` (data URL) দিয়ে বদলে দেওয়া হয়।
 * - মার্কশিটের রং/ফন্ট স্ক্রিনের মতোই আসে; প্রিন্টের মতো `@media print` নিয়ম
 *   (যেমন compact শিটের ১২৯.৪ মিমি উচ্চতা) এখানে প্রযোজ্য নয় — ছবি `contain`
 *   হিসেবে স্লটে বসে, তাই বিকৃতি হয় না।
 */

const MM_PER_INCH = 25.4;
const MARGIN_MM = 0.75 * MM_PER_INCH; // ১৯.০৫ মিমি — print.css-এর @page margin
const PAGE_W_MM = 210;
const PAGE_H_MM = 297;
const CONTENT_W_MM = PAGE_W_MM - MARGIN_MM * 2; // ১৭১.৯ মিমি
const CONTENT_H_MM = PAGE_H_MM - MARGIN_MM * 2; // ২৫৮.৯ মিমি

/** ফাইলের নামে ব্যবহার করা যায় না এমন অক্ষর সরানো (বাংলা অক্ষর রাখা হয়)। */
export function sanitizePdfFilename(name) {
  return String(name ?? 'marksheet')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/, '') || 'marksheet';
}

/**
 * ক্লোন করা ডকুমেন্টের প্রতিটি ইনলাইন SVG-কে data-URL ছবি দিয়ে বদলে দেওয়া —
 * html2canvas SVG আঁকতে পারে না, `<img>` পারে। QR কোড এভাবেই PDF-এ আসে।
 */
function swapSvgsForImages(clonedDoc) {
  clonedDoc.querySelectorAll('svg').forEach((svg) => {
    try {
      const width = Number(svg.getAttribute('width') || svg.clientWidth || 160);
      const height = Number(svg.getAttribute('height') || svg.clientHeight || 160);
      const clone = svg.cloneNode(true);
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      clone.setAttribute('width', String(width));
      clone.setAttribute('height', String(height));
      const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
        new globalThis.XMLSerializer().serializeToString(clone),
      )}`;
      const img = clonedDoc.createElement('img');
      img.src = dataUrl;
      img.width = width;
      img.height = height;
      img.style.width = `${width}px`;
      img.style.height = `${height}px`;
      svg.replaceWith(img);
    } catch {
      // একটি SVG বদলানো না গেলে সেটি বাদ যাবে; বাকি শিট তবুও তৈরি হবে।
    }
  });
}

/**
 * একটি ছবিকে (w × h মিমি) স্লটের ভেতরে বিকৃতি ছাড়া বসানোর মাপ (contain)।
 */
function fitInto(imgW, imgH, slotW, slotH) {
  const scale = Math.min(slotW / imgW, slotH / imgH);
  return { w: imgW * scale, h: imgH * scale };
}

/**
 * কনটেইনারের ভেতরের প্রতিটি `.print-sheet` এলিমেন্টকে A4 PDF-এ রেন্ডার করে
 * সরাসরি ডাউনলোড করে।
 *
 * @param {Element} containerEl `.print-sheet` এলিমেন্টগুলোর ধারক (print-root)
 * @param {{ filename?: string, sheetsPerPage?: 1|2 }} options
 * @returns {Promise<{ pages: number, sheets: number }>}
 * @throws কনটেইনারে কোনো শিট না থাকলে বা রেন্ডারে ব্যর্থ হলে
 */
export async function downloadSheetsAsPdf(containerEl, { filename = 'marksheet.pdf', sheetsPerPage = 1 } = {}) {
  const sheets = [...(containerEl?.querySelectorAll?.('.print-sheet') ?? [])]
    .filter((sheet) => sheet.offsetParent !== null || sheet.getClientRects().length > 0);
  if (!sheets.length) {
    throw new Error('PDF-এর জন্য কোনো মার্কশিট পাওয়া যায়নি।');
  }
  const perPage = sheetsPerPage === 2 ? 2 : 1;
  const slotH = CONTENT_H_MM / perPage;

  const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
  let pageCount = 0;

  for (let index = 0; index < sheets.length; index += 1) {
    const sheet = sheets[index];
    const canvas = await html2canvas(sheet, {
      scale: 2,
      useCORS: true,
      backgroundColor: '#ffffff',
      logging: false,
      onclone: (clonedDoc) => swapSvgsForImages(clonedDoc),
    });
    const imgData = canvas.toDataURL('image/jpeg', 0.92);
    const imgW = (canvas.width / 96) * MM_PER_INCH;
    const imgH = (canvas.height / 96) * MM_PER_INCH;
    const slotIndex = index % perPage;
    if (slotIndex === 0) {
      if (index > 0) pdf.addPage('a4', 'portrait');
      pageCount += 1;
    }
    const slotTop = MARGIN_MM + slotIndex * slotH;
    const { w, h } = fitInto(imgW, imgH, CONTENT_W_MM, slotH);
    pdf.addImage(imgData, 'JPEG', MARGIN_MM + (CONTENT_W_MM - w) / 2, slotTop + (slotH - h) / 2, w, h);
  }

  pdf.save(sanitizePdfFilename(filename));
  return { pages: pageCount, sheets: sheets.length };
}

export default downloadSheetsAsPdf;
