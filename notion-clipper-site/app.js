// Section rail tracking (matching todorx.dev) and hero clip stage animation.
// Everything degrades cleanly without JS or with reduced motion.

const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
const stage = document.getElementById("stage");

if (still) {
  stage?.classList.add("run");
} else if (stage) {
  const stageWatcher = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add("run");
      stageWatcher.unobserve(entry.target);
    }
  }, { rootMargin: "0px 0px -10% 0px", threshold: 0.15 });
  stageWatcher.observe(stage);
}

const railLinks = [...document.querySelectorAll(".rail a[href^='#']")];
if (railLinks.length) {
  const sections = railLinks
    .map((a) => ({ a, el: document.getElementById(a.getAttribute("href").slice(1)) }))
    .filter((s) => s.el);

  const setActive = (id) => {
    for (const { a, el } of sections) {
      if (el.id === id) a.setAttribute("aria-current", "location");
      else a.removeAttribute("aria-current");
    }
  };

  const railWatcher = new IntersectionObserver((entries) => {
    const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio);
    if (visible[0]) setActive(visible[0].target.id);
  }, { rootMargin: "-25% 0px -55% 0px", threshold: [0, 0.25, 0.5] });

  for (const { el } of sections) railWatcher.observe(el);
}
