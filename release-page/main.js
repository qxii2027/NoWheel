(function () {
  'use strict';

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var gsap = window.gsap;

  document.querySelectorAll('.code').forEach(function (block) {
    var button = block.querySelector('.copy');
    var code = block.querySelector('code');
    if (!button || !code) return;
    button.setAttribute('aria-live', 'polite');

    button.addEventListener('click', function () {
      var text = code.textContent.trim();
      var done = function (label) {
        button.textContent = label;
        window.setTimeout(function () {
          button.textContent = 'copy';
        }, 1600);
      };
      var selectCode = function () {
        try {
          var range = document.createRange();
          range.selectNodeContents(code);
          var selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
        } catch (error) {
          /* selection is a best effort */
        }
        done('select');
      };

      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(
          function () { done('copied'); },
          selectCode
        );
      } else {
        selectCode();
      }
    });
  });

  if (!gsap || reduceMotion) return;

  var ScrollTrigger = window.ScrollTrigger;
  if (ScrollTrigger) gsap.registerPlugin(ScrollTrigger);

  var intro = gsap.timeline({ defaults: { ease: 'power4.out' } });
  intro
    .from('[data-line]', { yPercent: 112, duration: 1.05, stagger: 0.09 }, 0.08)
    .from('.hero [data-reveal]', { y: 24, opacity: 0, duration: 0.8, stagger: 0.08 }, 0.34);

  var outerRing = document.querySelector('.wheel__ring--outer');
  if (outerRing) {
    var radius = Number(outerRing.getAttribute('r'));
    var circumference = 2 * Math.PI * radius;
    gsap.set(outerRing, { strokeDasharray: circumference, strokeDashoffset: circumference });
    gsap.to(outerRing, {
      strokeDashoffset: 0,
      duration: 1.7,
      ease: 'power2.inOut',
      delay: 0.15
    });
  }

  gsap.from('.wheel__spokes path', {
    opacity: 0,
    duration: 0.9,
    stagger: 0.05,
    delay: 0.55,
    ease: 'power2.out'
  });

  gsap.from('.wheel__hub', {
    scale: 0,
    transformOrigin: '50% 50%',
    duration: 0.7,
    ease: 'back.out(2)',
    delay: 0.9
  });

  gsap.to('.wheel__orbit', {
    rotation: 360,
    svgOrigin: '120 120',
    duration: 18,
    repeat: -1,
    ease: 'none'
  });

  gsap.to('.wheel__ring--inner', {
    rotation: 360,
    svgOrigin: '120 120',
    duration: 60,
    repeat: -1,
    ease: 'none'
  });

  if (!ScrollTrigger) return;

  var rot = document.getElementById('rot');
  if (rot) {
    var progress = { value: 0 };
    gsap.to(progress, {
      value: 360,
      ease: 'none',
      scrollTrigger: {
        trigger: document.documentElement,
        start: 'top top',
        end: 'bottom bottom',
        scrub: 0.6
      },
      onUpdate: function () {
        rot.textContent = String(Math.round(progress.value) % 360).padStart(3, '0');
      }
    });
  }

  gsap.utils.toArray('.section [data-reveal]').forEach(function (element) {
    gsap.from(element, {
      y: 26,
      opacity: 0,
      duration: 0.85,
      ease: 'power3.out',
      scrollTrigger: {
        trigger: element,
        start: 'top 88%',
        once: true
      }
    });
  });

  gsap.utils.toArray('.hair').forEach(function (element) {
    gsap.fromTo(element, { scaleX: 0 }, {
      scaleX: 1,
      duration: 1.1,
      ease: 'power3.inOut',
      scrollTrigger: {
        trigger: element,
        start: 'top 94%',
        once: true
      }
    });
  });
})();
