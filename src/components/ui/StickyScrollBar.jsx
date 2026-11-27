import { useEffect, useRef, useState } from 'react';

/**
 * পর্দার নিচে আটকে থাকা অনুভূমিক স্ক্রল বার।
 *
 * সমস্যা: রেজাল্ট গ্রিডের নিজস্ব স্ক্রল বার টেবিলের অনেক নিচে থাকে — মাঝখানে বা
 * শুরুতে স্ক্রল করতে বারবার নিচে যেতে হয়। আগের সংস্করণে `position: sticky`
 * ব্যবহার করা হয়েছিল, কিন্তু sticky শুধু নিজের প্যারেন্টের ভেতরেই আটকায় —
 * গ্রিড লম্বা হলে (অনেক শিক্ষার্থী) বার পেজের সঙ্গে উপরে চলে যেত, তাই নিচে
 * নামতে হতো। এখন বার `position: fixed` — পেজ যেখানেই স্ক্রল করা থাকুক, বার
 * সবসময় স্ক্রিনের নিচে থাকে; গ্রিড পর্দায় না থাকলে বার নিজে লুকিয়ে যায়।
 * টেবিলের সঙ্গে দুই দিকেই সিঙ্ক হয় — বার টানলে টেবিল স্ক্রল হয়, টেবিল স্ক্রল
 * করলে বার নড়ে।
 *
 * মাউন্টের ফাঁদ (ব্যাচ ৫এফ-এ ঠিক করা): আগের কোডে একটাই effect ছিল, যেটা
 * `if (!target || !bar) return undefined` দিয়ে শুরুতেই ফিরে যেত। কিন্তু বার
 * শুরুতে `visible=false` বলে রেন্ডারই হতো না (`barRef.current === null`), তাই
 * `measure()` কখনো চলত না আর `visible` কখনো `true` হতো না — বার কোনোদিনই
 * দেখা দিত না। এখন দুটো আলাদা effect: প্রথমটা শুধু টার্গেট (টেবিল) মাপে —
 * বারের এলিমেন্ট ছাড়াই; দ্বিতীয়টা বার মাউন্ট হলেই তাকে টার্গেটের সঙ্গে সিঙ্ক
 * করে আর বারের স্ক্রল শোনে।
 *
 * টেবিলটি কপি করা হয় না: বারটি শুধু একটি খালি ট্র্যাক (`overflow-x-auto`) যার
 * ভেতরের অংশের প্রস্থ টেবিলের `scrollWidth`-এর সমান। মূল টেবিলের নিজস্ব স্ক্রল
 * বার যেমন ছিল তেমনই থাকে — এটি তার পাশে একটি অতিরিক্ত, সবসময় দৃশ্যমান বার।
 *
 * ব্যবহার:
 *   const scrollWrapRef = useRef(null);
 *   <div ref={scrollWrapRef} className="overflow-x-auto">…table…</div>
 *   <StickyScrollBar targetRef={scrollWrapRef} label="রেজাল্ট টেবিল স্ক্রল" />
 *
 * বারটি শুধু তখনই দেখায় যখন টেবিল আসলেই পাশে স্ক্রল করার মতো চওড়া এবং
 * গ্রিডটি পর্দায় (আংশিক হলেও) দেখা যাচ্ছে।
 */
export default function StickyScrollBar({ targetRef, label = 'টেবিল পাশে স্ক্রল করুন' }) {
  const barRef = useRef(null);
  const syncingRef = useRef(false);
  const [trackWidth, setTrackWidth] = useState(0);
  const [visible, setVisible] = useState(false);
  /** স্ক্রিনে বারের অবস্থান — টেবিলের বাম কিনারা ও প্রস্থের সঙ্গে মিলিয়ে। */
  const [placement, setPlacement] = useState({ left: 0, width: 0, inView: false });

  /**
   * Effect 1 — শুধু টার্গেট (টেবিল) মাপা। বারের এলিমেন্টের কোনো দরকার নেই, তাই
   * বার এখনো মাউন্ট না হলেও এই effect চলে আর `visible` ঠিক করে দিতে পারে।
   * টেবিল স্ক্রল করলে বারের স্ক্রলও মিলিয়ে দেয় (বার থাকলে; না থাকলে কিছু করে না)।
   */
  useEffect(() => {
    const target = targetRef?.current;
    if (!target) return undefined;

    /** টেবিলের চওড়া অনুযায়ী বারের ট্র্যাক মাপা + দৃশ্যমানতা ঠিক করা। */
    const measure = () => {
      const needsScroll = target.scrollWidth > target.clientWidth + 1;
      setVisible(needsScroll);
      setTrackWidth(target.scrollWidth);
      const rect = target.getBoundingClientRect();
      setPlacement({
        left: rect.left,
        width: rect.width,
        // গ্রিড পর্দায় আংশিক হলেও দেখা গেলেই বার দেখাবে; গ্রিড পেরিয়ে গেলে লুকাবে।
        inView: rect.top < window.innerHeight && rect.bottom > 0,
      });
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

    const onTargetScroll = () => {
      const bar = barRef.current;
      if (!bar || syncingRef.current) return;
      syncingRef.current = true;
      bar.scrollLeft = target.scrollLeft;
      syncingRef.current = false;
    };

    target.addEventListener('scroll', onTargetScroll, { passive: true });
    window.addEventListener('resize', onScrollOrResize);
    window.addEventListener('scroll', onScrollOrResize, { passive: true });
    const observer = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(measure)
      : null;
    observer?.observe(target);

    return () => {
      target.removeEventListener('scroll', onTargetScroll);
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('scroll', onScrollOrResize);
      observer?.disconnect();
    };
  }, [targetRef]);

  /**
   * Effect 2 — বার মাউন্ট হলেই (`visible` / `inView` বদলালে) তাকে টার্গেটের
   * বর্তমান স্ক্রল অবস্থায় বসানো আর বারের স্ক্রল শোনা (বার টানলে টেবিল নড়ে)।
   * বার লুকিয়ে গেলে (unmount) লিসেনারও খুলে যায়।
   */
  useEffect(() => {
    const target = targetRef?.current;
    const bar = barRef.current;
    if (!target || !bar) return undefined;
    bar.scrollLeft = target.scrollLeft;

    const onBarScroll = () => {
      if (syncingRef.current) return;
      syncingRef.current = true;
      target.scrollLeft = bar.scrollLeft;
      syncingRef.current = false;
    };

    bar.addEventListener('scroll', onBarScroll, { passive: true });
    return () => bar.removeEventListener('scroll', onBarScroll);
  }, [visible, placement.inView, targetRef]);

  if (!visible || !placement.inView) return null;

  return (
    <div
      className="fixed bottom-0 z-40 border-t border-slate-200 bg-white/95 px-1 py-1.5 shadow-[0_-2px_10px_rgba(0,0,0,0.08)] backdrop-blur-sm dark:border-slate-700 dark:bg-slate-900/95"
      style={{ left: placement.left, width: placement.width || undefined }}
      aria-hidden="false"
    >
      <div
        ref={barRef}
        role="scrollbar"
        aria-label={label}
        aria-orientation="horizontal"
        tabIndex={0}
        className="scroll-thin max-w-full overflow-x-auto overflow-y-hidden"
      >
        <div style={{ width: trackWidth || undefined, height: 10 }} aria-hidden="true" />
      </div>
      <p className="mt-0.5 text-center text-[10px] font-semibold text-slate-400">
        ◀ পাশে স্ক্রল করুন ▶
      </p>
    </div>
  );
}
