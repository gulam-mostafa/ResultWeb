import { useEffect, useRef, useState } from 'react';
import { clsx } from '../../utils/clsx.js';

/**
 * নম্বর গ্রিডের আটকে-থাকা হেডার + উপরের স্ক্রল বার — একটাই, কখনো ডাবল নয়।
 *
 * কেন `sticky top-0` দিয়ে হয়নি (ব্যাচ ৫এফ): গ্রিডের উপরের ট্যাব বারটি
 * `sticky top-0` ছিল, তবু স্ক্রল করলে পেজের সঙ্গে উপরে চলে যেত — আর
 * টেবিলের নিজের গ্রুপ হেডার সারির সঙ্গে মিলে একই তিনটি সেকশন দুইবার
 * দেখাত। স্ট্যাটিক কোডে এমন কোনো একক `overflow: hidden` পূর্বপুরুষ খুঁজে
 * পাওয়া যায়নি যা নিশ্চিতভাবে sticky ভাঙে (টপবারের নিজের sticky ঠিকই
 * কাজ করে) — তাই কারণ অনুমান করে আরেকবার sticky চেষ্টা না করে, বারটি
 * এবার `position: fixed` + JS মাপজোখ (getBoundingClientRect) দিয়ে বসানো
 * হয়েছে — StickyScrollBar-এর প্রমাণিত প্যাটার্ন, পূর্বপুরুষ যাই হোক কাজ করে।
 *
 * যা যা হয়:
 *  • পেজের উপরে থাকলে শুধু টেবিলের নিজের গ্রুপ হেডার সারি দেখায়; নিচে
 *    স্ক্রল করলে সেই সারি পর্দার উপর দিয়ে পেরিয়ে গেলেই ফিক্সড বারটি
 *    দেখা দেয় — একসঙ্গে দুটো হেডার কখনো দেখায় না।
 *  • ফিক্সড বারটি টেবিলের বাম কিনারা/চওড়া মেনে চলে, অ্যাপ টপবারের
 *    ঠিক নিচে বসে (টপবারের উচ্চতা রানটাইমে মাপা হয়), আর ট্যাবগুলো
 *    টেবিলের আসল গ্রুপ হেডার ঘরের মাপেই বসে — টেবিল পাশে স্ক্রল করলে
 *    ট্যাবের সারিটিও সঙ্গে সঙ্গে সরে (শিক্ষার্থী কলামটি টেবিলের মতোই
 *    বামে আটকে থাকে)। ট্যাবে ক্লিক করলে `onTabClick` ডাকে — সেই
 *    সেকশন ডিসপ্লের মাঝখানে আসে, আগের মতোই।
 *  • আরও নিচে স্ক্রল করলে সাবজেক্ট হেডার সারিটাও (বিষয়, পূর্ণমান,
 *    গাঠনিক, সামষ্টিক, মোট, GPA, গ্রেড…) ট্যাব বারের ঠিক নিচে আটকে
 *    থাকে — আসল সারির th ঘরগুলোর মাপেই, টেবিলের স্ক্রলের সঙ্গে
 *    translate হয়; আসল সারি আড়ালে গেলেই শুধু দেখায় (ব্যাচ ৫k)।
 *  • স্ক্রল বার একটাই: টেবিলের নিজস্ব স্ক্রল বার লুকানো থাকে
 *    (`.grid-scroll-hidden`)। গ্রিডের উপরে, টেবিলের ঠিক উপরে, একটি
 *    ইন-ফ্লো স্ক্রল বার থাকে; নিচে স্ক্রল করলে সেটি পেজের সঙ্গে উপরে
 *    চলে গেলে ফিক্সড বারের নিচে একই স্ক্রল বার দেখা দেয় — দুটো
 *    একসঙ্গে কখনো দেখায় না, দুটোই টেবিলের সঙ্গে দুই দিকে সিঙ্ক হয়
 *    (বার টানলে টেবিল নড়ে, টেবিল স্ক্রল করলে বার নড়ে)।
 *  • গ্রিড পর্দায় না থাকলে (পেরিয়ে গেলে) ফিক্সড বার লুকিয়ে যায়;
 *    মোবাইলে (কার্ড ভিউ, পাশে স্ক্রল নেই) কিছুই দেখায় না।
 *
 * স্ক্রল সিঙ্কের প্রতিধ্বনি-গার্ড (ব্যাচ ৫k): টেবিল স্ক্রল করলে বারগুলোকে
 * সিঙ্ক করা হয়; বারের নিজের `scroll` ইভেন্ট অ্যাসিঙ্ক্রোনাসভাবে পরে
 * আসে — গার্ড ছাড়া সেটি টেবিলের scrollLeft-কে সিঙ্কের সময়ের পুরনো মানে
 * ফিরিয়ে দিত, ফলে `smooth` স্ক্রল মাঝপথে বাতিল হয়ে এক ক্লিকে মাত্র
 * কয়েক পিক্সেল সরত। তাই বারের ইভেন্ট তখনই টেবিল চালায় যখন বারের
 * scrollLeft শেষ সিঙ্ক করা মান থেকে স্পষ্ট সরে গেছে (ব্যবহারকারী টেনেছে)।
 *
 * মাপা কখনো বারের এলিমেন্টের উপর নির্ভর করে না (ব্যাচ ৫এফ-এর মাউন্ট
 * বাগের শিক্ষা): measure শুধু টেবিল + হেডার সারি মাপে।
 *
 * ব্যবহার:
 *   <GridPinnedBar
 *     tableWrapRef={tableWrapRef}
 *     headerRowRef={headerRowRef}
 *     subjectRowRef={subjectRowRef}
 *     tabs={[{ key, label, hint, head }, ...]} // টেবিলের গ্রুপ হেডার ঘরের ক্রমে
 *     subjectCells={[{ key, label, sub, className }, ...]} // সাবজেক্ট সারির ক্রমে
 *     onTabClick={centerSection}
 *     label="নম্বর গ্রিড পাশে স্ক্রল করুন"
 *   />
 */

const TOPBAR_FALLBACK_PX = 64;

/** দুটো জ্যামিতি একই কি না — অপরিবর্তিত মাপে অযথা রি-রেন্ডার ঠেকাতে। */
function sameGeom(a, b) {
  if (!a || !b) return false;
  if (
    a.showFixed !== b.showFixed
    || a.showTabs !== b.showTabs
    || a.showSubject !== b.showSubject
    || a.left !== b.left
    || a.width !== b.width
    || a.top !== b.top
    || a.tabRowHeight !== b.tabRowHeight
    || a.subjectRowHeight !== b.subjectRowHeight
    || a.studentWidth !== b.studentWidth
    || a.tabRects.length !== b.tabRects.length
    || a.subjectRects.length !== b.subjectRects.length
  ) return false;
  const rectsEqual = (left, right) => left.every((rect, i) => (
    rect.key === right[i].key
    && rect.offset === right[i].offset
    && rect.width === right[i].width
  ));
  return rectsEqual(a.tabRects, b.tabRects) && rectsEqual(a.subjectRects, b.subjectRects);
}

export default function GridPinnedBar({
  tableWrapRef,
  headerRowRef,
  subjectRowRef,
  tabs = [],
  subjectCells = [],
  onTabClick,
  label = 'টেবিল পাশে স্ক্রল করুন',
}) {
  const flowBarRef = useRef(null);
  const fixedBarRef = useRef(null);
  const stripRef = useRef(null);
  const subjectStripRef = useRef(null);
  const syncingRef = useRef(false);
  /** টেবিল থেকে বারে শেষ সিঙ্ক করা scrollLeft — বারের নিজের ইভেন্ট এই মানের
      কাছাকাছি থাকলে সেটি প্রতিধ্বনি, ব্যবহারকারীর টান নয় (ব্যাচ ৫k)। */
  const lastSetBarScrollRef = useRef(0);
  const [trackWidth, setTrackWidth] = useState(0);
  const [geom, setGeom] = useState({
    showFixed: false,
    showTabs: false,
    showSubject: false,
    left: 0,
    width: 0,
    top: TOPBAR_FALLBACK_PX,
    tabRowHeight: 0,
    subjectRowHeight: 0,
    studentWidth: 0,
    tabRects: [],
    subjectRects: [],
  });

  /**
   * Effect 1 — শুধু টেবিল + হেডার সারি + সাবজেক্ট সারি মাপা। বারের
   * এলিমেন্টের কোনো দরকার নেই, তাই বার এখনো মাউন্ট না হলেও এই effect চলে।
   */
  useEffect(() => {
    const wrap = tableWrapRef?.current;
    if (!wrap) return undefined;

    const measure = () => {
      const wrapRect = wrap.getBoundingClientRect();
      const topbar = document.querySelector('.app-topbar');
      const top = topbar
        ? Math.round(topbar.getBoundingClientRect().height)
        : TOPBAR_FALLBACK_PX;
      const headerRow = headerRowRef?.current;
      const headerRect = headerRow?.getBoundingClientRect();
      const headerBottom = headerRect ? headerRect.bottom : Infinity;
      const headerHeight = headerRect ? Math.round(headerRect.height) : 0;

      // ট্যাবের মাপ টেবিলের আসল গ্রুপ হেডার ঘর থেকেই নেওয়া — প্রথম th
      // শিক্ষার্থী কলাম (আটকে থাকে), বাকিগুলো tabs-এর ক্রমেই সেকশন।
      let tabRects = [];
      let studentWidth = 0;
      if (headerRow && tabs.length) {
        const ths = [...headerRow.querySelectorAll('th')];
        if (ths.length - 1 === tabs.length) {
          studentWidth = Math.round(ths[0].getBoundingClientRect().width);
          tabRects = tabs.map((tab, i) => {
            const rect = ths[i + 1].getBoundingClientRect();
            return {
              key: tab.key,
              // টেবিলের কনটেন্ট-ভেতরের অবস্থান (স্ক্রল যোগ করে)।
              offset: Math.round(rect.left - wrapRect.left + wrap.scrollLeft),
              width: Math.round(rect.width),
            };
          });
        }
      }

      // সাবজেক্ট সারির মাপ আসল সাবজেক্ট সারির th ঘর থেকেই — subjectCells-এর
      // ক্রমেই (গ্রুপের বিষয়গুলো, তারপর মোট/GPA/গ্রেড/মেধাক্রম/নতুন রোল/মন্তব্য)।
      let subjectRects = [];
      let subjectHeight = 0;
      let subjectBottom = Infinity;
      const subjectRow = subjectRowRef?.current;
      if (subjectRow && subjectCells.length) {
        const subjectRect = subjectRow.getBoundingClientRect();
        subjectBottom = subjectRect.bottom;
        subjectHeight = Math.round(subjectRect.height);
        const ths = [...subjectRow.querySelectorAll('th')];
        if (ths.length === subjectCells.length) {
          subjectRects = subjectCells.map((cell, i) => {
            const rect = ths[i].getBoundingClientRect();
            return {
              key: cell.key,
              // টেবিলের কনটেন্ট-ভেতরের অবস্থান (স্ক্রল যোগ করে)।
              offset: Math.round(rect.left - wrapRect.left + wrap.scrollLeft),
              width: Math.round(rect.width),
            };
          });
        }
      }

      // গ্রিড পর্দায় আংশিক হলেও আছে কি না; টেবিলের উপরের কিনারা টপবারে
      // পৌঁছালেই ফিক্সড বার দেখাবে; গ্রুপ হেডার সারি উপরে পেরিয়ে গেলেই
      // ফিক্সড ট্যাব দেখাবে (তার আগে টেবিলের নিজের হেডারই দেখা যায়)।
      const gridInView = wrapRect.bottom > top + 40 && wrapRect.top < window.innerHeight;
      const showFixed = gridInView && wrapRect.top <= top + 1;
      const showTabs = headerBottom < top + 1 && tabRects.length === tabs.length;
      // সাবজেক্ট সারি দেখাবে শুধু তখনই, যখন ট্যাব দেখাচ্ছে আর আসল সাবজেক্ট
      // সারি ট্যাব বারের নিচ দিয়ে উপরে পেরিয়ে গেছে (তার আগে নিজের সারিই দেখা যায়)।
      const showSubject = showTabs
        && subjectCells.length > 0
        && subjectRects.length === subjectCells.length
        && subjectBottom < top + headerHeight + 1;

      setTrackWidth(wrap.scrollWidth);
      setGeom((prev) => {
        const next = {
          showFixed,
          showTabs,
          showSubject,
          left: Math.round(wrapRect.left),
          width: Math.round(wrapRect.width),
          top,
          tabRowHeight: headerHeight,
          subjectRowHeight: subjectHeight,
          studentWidth,
          tabRects,
          subjectRects,
        };
        return sameGeom(prev, next) ? prev : next;
      });
      // ট্যাবের সারিটি টেবিলের বর্তমান স্ক্রলেই থাকুক।
      if (stripRef.current) {
        stripRef.current.style.transform = `translateX(${-wrap.scrollLeft}px)`;
      }
      if (subjectStripRef.current) {
        subjectStripRef.current.style.transform = `translateX(${-wrap.scrollLeft}px)`;
      }
    };
    measure();

    let ticking = false;
    const onScrollOrResize = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        measure();
      });
    };

    window.addEventListener('scroll', onScrollOrResize, { passive: true });
    window.addEventListener('resize', onScrollOrResize);
    const observer = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(measure)
      : null;
    observer?.observe(wrap);
    const headerRowEl = headerRowRef?.current;
    if (headerRowEl) observer?.observe(headerRowEl);
    const subjectRowEl = subjectRowRef?.current;
    if (subjectRowEl) observer?.observe(subjectRowEl);

    return () => {
      window.removeEventListener('scroll', onScrollOrResize);
      window.removeEventListener('resize', onScrollOrResize);
      observer?.disconnect();
    };
  }, [tableWrapRef, headerRowRef, subjectRowRef, tabs, subjectCells]);

  /**
   * Effect 2 — স্ক্রল সিঙ্ক (দুই দিকেই): টেবিল স্ক্রল করলে দুটো বার +
   * ট্যাবের সারি + সাবজেক্ট সারি নড়ে; বার টানলে টেবিল নড়ে। ফিক্সড বার
   * মাউন্ট হলে (showFixed / showSubject বদলালে) তাকে টেবিলের বর্তমান
   * স্ক্রলে বসানো হয়। বারের ইভেন্ট প্রতিধ্বনি হলে (টেবিল থেকে সিঙ্ক
   * করা মানে এখনো আছে) টেবিল ছোঁয়া হয় না — নইলে টেবিলের স্ক্রল
   * মাঝপথে বাতিল হয়ে এক ক্লিকে মাত্র কয়েক পিক্সেল সরত (ব্যাচ ৫k)।
   */
  useEffect(() => {
    const wrap = tableWrapRef?.current;
    if (!wrap) return undefined;

    const syncBarsFromWrap = () => {
      if (syncingRef.current) return;
      syncingRef.current = true;
      const x = wrap.scrollLeft;
      if (flowBarRef.current) flowBarRef.current.scrollLeft = x;
      if (fixedBarRef.current) fixedBarRef.current.scrollLeft = x;
      lastSetBarScrollRef.current = x;
      if (stripRef.current) {
        stripRef.current.style.transform = `translateX(${-x}px)`;
      }
      if (subjectStripRef.current) {
        subjectStripRef.current.style.transform = `translateX(${-x}px)`;
      }
      syncingRef.current = false;
    };
    syncBarsFromWrap();

    const onBarScroll = (bar) => () => {
      if (syncingRef.current) return;
      // প্রতিধ্বনি: বারটি টেবিলের সিঙ্কে সেট করা মানেই আছে — ব্যবহারকারী
      // টানেনি, তাই টেবিলের scrollLeft-এ হাত দেওয়া যাবে না।
      if (Math.abs(bar.scrollLeft - lastSetBarScrollRef.current) < 2) return;
      syncingRef.current = true;
      wrap.scrollLeft = bar.scrollLeft;
      lastSetBarScrollRef.current = bar.scrollLeft;
      if (flowBarRef.current && flowBarRef.current !== bar) {
        flowBarRef.current.scrollLeft = bar.scrollLeft;
      }
      if (fixedBarRef.current && fixedBarRef.current !== bar) {
        fixedBarRef.current.scrollLeft = bar.scrollLeft;
      }
      if (stripRef.current) {
        stripRef.current.style.transform = `translateX(${-bar.scrollLeft}px)`;
      }
      if (subjectStripRef.current) {
        subjectStripRef.current.style.transform = `translateX(${-bar.scrollLeft}px)`;
      }
      syncingRef.current = false;
    };

    const flowBar = flowBarRef.current;
    const fixedBar = fixedBarRef.current;
    const onFlowBarScroll = flowBar ? onBarScroll(flowBar) : null;
    const onFixedBarScroll = fixedBar ? onBarScroll(fixedBar) : null;

    wrap.addEventListener('scroll', syncBarsFromWrap, { passive: true });
    if (flowBar && onFlowBarScroll) flowBar.addEventListener('scroll', onFlowBarScroll, { passive: true });
    if (fixedBar && onFixedBarScroll) fixedBar.addEventListener('scroll', onFixedBarScroll, { passive: true });
    return () => {
      wrap.removeEventListener('scroll', syncBarsFromWrap);
      if (flowBar && onFlowBarScroll) flowBar.removeEventListener('scroll', onFlowBarScroll);
      if (fixedBar && onFixedBarScroll) fixedBar.removeEventListener('scroll', onFixedBarScroll);
    };
  }, [tableWrapRef, geom.showFixed, geom.showSubject, trackWidth]);

  return (
    <>
      {/* ইন-ফ্লো উপরের স্ক্রল বার — টেবিলের ঠিক উপরে, পেজের উপরে থাকলে এটাই
          দেখায়; নিচে স্ক্রল করলে পেজের সঙ্গে উপরে চলে যায় আর ফিক্সড বার
          তার জায়গা নেয়। ডেস্কটপ/ট্যাবলেটে দেখায়; মোবাইলে কার্ড ভিউ। */}
      <div
        className="hidden border-b border-slate-200 bg-slate-50/90 md:block dark:border-slate-700 dark:bg-slate-800/80"
        aria-hidden="false"
      >
        <div
          ref={flowBarRef}
          role="scrollbar"
          aria-label={label}
          aria-orientation="horizontal"
          tabIndex={0}
          title={label}
          className="max-w-full overflow-x-auto overflow-y-hidden"
        >
          <div style={{ width: trackWidth || undefined, height: 10 }} aria-hidden="true" />
        </div>
      </div>

      {/* ফিক্সড বার — টপবারের ঠিক নিচে, টেবিলের বাম কিনারা/চওড়া মেনে।
          ট্যাবের সারি শুধু তখনই দেখায় যখন টেবিলের নিজের গ্রুপ হেডার
          সারি উপরে পেরিয়ে গেছে; সাবজেক্ট সারি দেখায় যখন আসল সাবজেক্ট
          সারিও ট্যাব বারের নিচ দিয়ে পেরিয়ে গেছে; স্ক্রল বার সবসময়
          দেখায় (যতক্ষণ গ্রিড পর্দায় আছে)। */}
      {geom.showFixed ? (
        <div
          className="fixed z-30 hidden overflow-hidden rounded-b-xl border border-slate-200 bg-white/95 shadow-md backdrop-blur-sm md:block dark:border-slate-700 dark:bg-slate-900/95"
          style={{ left: geom.left, width: geom.width || undefined, top: geom.top }}
        >
          {geom.showTabs && geom.tabRects.length ? (
            <div
              className="relative overflow-hidden border-b border-slate-200 dark:border-slate-700"
              style={{ height: geom.tabRowHeight || undefined }}
              role="tablist"
              aria-label="মূল্যায়ন সেকশন — ক্লিক করলে সেই অংশ মাঝখানে আসবে"
            >
              {/* ট্যাবের সারি — টেবিলের স্ক্রলের সঙ্গে translate হয়। */}
              <div
                ref={stripRef}
                className="absolute inset-y-0 left-0 will-change-transform"
                style={{ width: trackWidth || undefined }}
              >
                {geom.tabRects.map((tabRect) => {
                  const tab = tabs.find((item) => item.key === tabRect.key);
                  if (!tab) return null;
                  return (
                    <button
                      key={`pinned-tab-${tab.key}`}
                      type="button"
                      role="tab"
                      onClick={() => onTabClick?.(tab.key)}
                      className={clsx(
                        'absolute inset-y-0 flex flex-col items-center justify-center px-1 text-center transition hover:brightness-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60',
                        tab.head,
                      )}
                      title={`${tab.label} — ক্লিক করলে এই অংশ মাঝখানে আসবে`}
                      aria-label={`${tab.label} মাঝখানে দেখুন`}
                      style={{ left: tabRect.offset, width: tabRect.width }}
                    >
                      <span className="block text-xs font-bold">{tab.label}</span>
                      <span className="block text-[10px] font-normal opacity-80">{tab.hint}</span>
                    </button>
                  );
                })}
              </div>
              {/* শিক্ষার্থী কলাম — টেবিলের মতোই বামে আটকে থাকে। */}
              <div
                className="absolute inset-y-0 left-0 z-10 flex items-center justify-center border-r border-slate-200 bg-white px-1 text-center text-xs font-bold text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                style={{ width: geom.studentWidth || undefined }}
              >
                শিক্ষার্থী / রোল
              </div>
            </div>
          ) : null}
          {/* সাবজেক্ট সারি — ট্যাব বারের নিচে, আসল সারির মাপেই; আসল সারি
              আড়ালে গেলেই দেখায়। আসল সারি এখনো পর্দায় আছে বলে এটি শুধু
              দেখার কপি (aria-hidden), ক্লিক করা যায় না। */}
          {geom.showSubject && geom.subjectRects.length ? (
            <div
              className="relative overflow-hidden border-b border-slate-200 dark:border-slate-700"
              style={{ height: geom.subjectRowHeight || undefined }}
              aria-hidden="true"
            >
              <div
                ref={subjectStripRef}
                className="absolute inset-y-0 left-0 will-change-transform"
                style={{ width: trackWidth || undefined }}
              >
                {geom.subjectRects.map((subjectRect) => {
                  const cell = subjectCells.find((item) => item.key === subjectRect.key);
                  if (!cell) return null;
                  return (
                    <div
                      key={`pinned-subject-${cell.key}`}
                      className={clsx(
                        'absolute inset-y-0 flex flex-col items-center justify-center px-1 text-center',
                        cell.className,
                      )}
                      style={{ left: subjectRect.offset, width: subjectRect.width }}
                    >
                      <span className="block max-w-24 truncate">{cell.label}</span>
                      {cell.sub ? (
                        <span className="block text-[10px] font-normal opacity-70">{cell.sub}</span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
              {/* শিক্ষার্থী কলাম — টেবিলের মতোই বামে আটকে থাকে। */}
              <div
                className="absolute inset-y-0 left-0 z-10 flex items-center justify-center border-r border-slate-200 bg-white px-1 text-center text-xs font-bold text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                style={{ width: geom.studentWidth || undefined }}
              >
                শিক্ষার্থী / রোল
              </div>
            </div>
          ) : null}
          <div
            ref={fixedBarRef}
            role="scrollbar"
            aria-label={label}
            aria-orientation="horizontal"
            tabIndex={0}
            title={label}
            className="max-w-full overflow-x-auto overflow-y-hidden"
          >
            <div style={{ width: trackWidth || undefined, height: 10 }} aria-hidden="true" />
          </div>
          <p className="border-t border-slate-100 py-0.5 text-center text-[10px] font-semibold text-slate-400 dark:border-slate-800">
            ◀ পাশে স্ক্রল করুন ▶
          </p>
        </div>
      ) : null}
    </>
  );
}
