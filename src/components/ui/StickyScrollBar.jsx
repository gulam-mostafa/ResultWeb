import { useEffect, useRef, useState } from 'react';

/**
 * পর্দার নিচে আটকে থাকা অনুভূমিক স্ক্রল বার।
 *
 * সমস্যা: রেজাল্ট গ্রিডের নিজস্ব স্ক্রল বার টেবিলের অনেক নিচে থাকে — মাঝখানে বা
 * শুরুতে স্ক্রল করতে বারবার নিচে যেতে হয়। এই বার `position: sticky; bottom: 0`
 * দিয়ে পর্দার নিচে আটকে থাকে (পেজ যেখানেই স্ক্রল করা থাকুক), আর টেবিলের সঙ্গে
 * দুই দিকেই সিঙ্ক হয় — বার টানলে টেবিল স্ক্রল হয়, টেবিল স্ক্রল করলে বার নড়ে।
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
 * বারটি শুধু তখনই দেখায় যখন টেবিল আসলেই পাশে স্ক্রল করার মতো চওড়া।
 */
export default function StickyScrollBar({ targetRef, label = 'টেবিল পাশে স্ক্রল করুন' }) {
  const barRef = useRef(null);
  const syncingRef = useRef(false);
  const [trackWidth, setTrackWidth] = useState(0);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const target = targetRef?.current;
    const bar = barRef.current;
    if (!target || !bar) return undefined;

    /** টেবিলের চওড়া অনুযায়ী বারের ট্র্যাক মাপা + দৃশ্যমানতা ঠিক করা। */
    const measure = () => {
      const needsScroll = target.scrollWidth > target.clientWidth + 1;
      setVisible(needsScroll);
      setTrackWidth(target.scrollWidth);
    };
    measure();

    const onTargetScroll = () => {
      if (syncingRef.current) return;
      syncingRef.current = true;
      bar.scrollLeft = target.scrollLeft;
      syncingRef.current = false;
    };
    const onBarScroll = () => {
      if (syncingRef.current) return;
      syncingRef.current = true;
      target.scrollLeft = bar.scrollLeft;
      syncingRef.current = false;
    };

    target.addEventListener('scroll', onTargetScroll, { passive: true });
    bar.addEventListener('scroll', onBarScroll, { passive: true });
    window.addEventListener('resize', measure);
    const observer = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(measure)
      : null;
    observer?.observe(target);

    return () => {
      target.removeEventListener('scroll', onTargetScroll);
      bar.removeEventListener('scroll', onBarScroll);
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, [targetRef]);

  if (!visible) return null;

  return (
    <div
      className="sticky bottom-0 z-30 -mx-1 border-t border-slate-200 bg-white/95 px-1 py-1.5 backdrop-blur-sm dark:border-slate-700 dark:bg-slate-900/95"
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
