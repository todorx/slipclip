// Reveal on scroll, and run the hero's clip animation once it is on screen.
// Everything degrades to "already visible" without JS or with reduced motion.

const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

if (still) {
  document.querySelectorAll(".reveal").forEach((el) => el.classList.add("seen"));
  document.getElementById("stage")?.classList.add("run");
} else {
  const watcher = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add(entry.target.id === "stage" ? "run" : "seen");
      watcher.unobserve(entry.target);
    }
  }, { rootMargin: "0px 0px -12% 0px", threshold: .15 });

  for (const el of document.querySelectorAll(".reveal, #stage")) watcher.observe(el);

  // Stagger tiles within a row so a grid arrives as a sequence, not a slab.
  document.querySelectorAll(".grid .reveal, .plain .reveal").forEach((el, i) => {
    el.style.transitionDelay = `${i * 70}ms`;
  });
}
