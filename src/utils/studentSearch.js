import { normalizeDigitsOnly, normalizeName } from './studentSimilarity.js';

/**
 * শিক্ষার্থী খোঁজা — নাম বা প্রোফাইলের যেকোনো তথ্য দিয়ে।
 *
 * আগে খোঁজা শুধু নাম / রোল / জন্ম নিবন্ধন / পিতা-মাতার নামে মিলত (StudentsPage)
 * বা নাম / রোল / পিতা-মাতার নাম / ফোনে মিলত (StudentTable) — বাংলা সংখ্যায় লেখা
 * রোল/ফোন/জন্ম নিবন্ধন মিলত না, ঠিকানা ও অভিভাবকের এনআইডি মিলত না।
 *
 * এখন একই নিয়ম দুই জায়গায় (রোস্টারের `?q=` খোঁজা ও টেবিলের নিজস্ব খোঁজা বাক্স)
 * ব্যবহৃত হয়, যাতে দুই খোঁজা কখনো ভিন্ন ফল না দেয়:
 * - নাম / পিতার নাম / মাতার নাম / ঠিকানা: `normalizeName` দিয়ে মেলানো
 *   (ছোট-বড় হাত, বাড়তি স্পেস, যতিচিহ্ন উপেক্ষা করা হয়)।
 * - রোল / ফোন (পিতা/মাতা/অভিভাবক) / জন্ম নিবন্ধন নম্বর / অভিভাবকের এনআইডি:
 *   বাংলা সংখ্যা আগে ASCII-তে বদলে (`normalizeDigitsOnly` — studentSimilarity.js-এর
 *   একই নরমালাইজার) তারপর মেলানো, তাই `০১৭…` আর `017…` একই নম্বর।
 * - খোঁজায় সংখ্যা থাকলে সংখ্যাভিত্তিক ফিল্ডগুলোও যাচাই করা হয়; শুধু অক্ষর থাকলে
 *   শুধু নামভিত্তিক ফিল্ডগুলো যাচাই করা হয়।
 * - একাধিক শিক্ষার্থী মিললে সবাইকে ফেরত দেওয়া হয় (কোনো একক ম্যাচ বাছা হয় না)।
 *
 * @param {object} student রোস্টারের এক শিক্ষার্থী
 * @param {string} query খোঁজার লেখা
 * @returns {boolean} মিললে true
 */
export function matchesStudentSearch(student, query) {
  if (!student) return false;
  const text = String(query ?? '').trim();
  if (!text) return true;
  const needleName = normalizeName(text);
  const needleDigits = normalizeDigitsOnly(text);
  const hasDigits = needleDigits.length > 0;

  const textFields = [
    student?.name,
    student?.fatherName,
    student?.motherName,
    student?.guardianName,
    student?.address,
  ];
  if (needleName && textFields.some((field) => normalizeName(field).includes(needleName))) return true;

  if (hasDigits) {
    const digitFields = [
      student?.roll,
      student?.fatherPhone,
      student?.motherPhone,
      student?.guardianPhone,
      student?.birthCertificateNo,
      student?.birthRegNo,
      student?.guardianNid,
    ];
    if (digitFields.some((field) => {
      const digits = normalizeDigitsOnly(field);
      return digits && digits.includes(needleDigits);
    })) return true;
  }

  return false;
}

export default matchesStudentSearch;
