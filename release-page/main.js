(function () {
  'use strict';

  var I18N = {
    zh: {
      metaTitle: 'NoWheel — 别再重新发明轮子',
      metaDescription: 'NoWheel 是一个 Agent Skill：让 AI 先问再做、使用真实图标库，并复用成熟的开源实现。',
      heroLine1: '别重新发明',
      heroLine2: '<em>轮子</em>。',
      heroLead: 'NoWheel 是一个面向界面开发的 Agent Skill。它让 AI 先问再做、使用真实图标库，并复用经过验证的开源实现，而不是从头造一遍。',
      btnDownload: '下载',
      btnInstall: '安装',
      sInstall: '安装',
      downloadTitle: '下载最新版本',
      stepNpx: '从 GitHub 直接安装，无需 clone：',
      stepClone: '或者 clone 后安装：',
      fineInstall: '需要 Node 18+，无需 npm install。',
      sChanges: '变化',
      askLabel: '先问',
      askTitle: '先问，再动手。',
      askBody: '布局、动效、依赖、许可证。只要决策真的存在分歧，AI 会停下来给出选项。',
      iconsLabel: '图标',
      iconsTitle: '用真图标。',
      iconsBody: '检测项目已有的图标库，搜索真实标识符，拉取官方 SVG。不画路径，不猜名字。',
      reuseLabel: '复用',
      reuseTitle: '复用现成的。',
      reuseBody: '复杂功能从检索开始：Star、维护状态、许可证、源码。基于成熟实现改造，而不是重写。',
      sHow: '原理',
      howText: '一个由 harness 加载的 <code>SKILL.md</code>。三个开关。两个<span class="nowrap">零依赖</span> Node 工具。',
      flowTask: '任务',
      flowSwitches: '开关',
      flowCode: '代码',
      howNote: 'AI 读取开关状态，只在对应规则开启时调用工具，然后把结果写进你的项目。没有守护进程，没有数据库，不需要安装。',
      sUse: '使用',
      useLead: '重启 harness，然后提出界面需求。技能会自动生效。',
      stepToggle: '切换三条规则：',
      stepIcons: '搜索真实图标：',
      fineUse: '支持 Claude Code、Codex、Gemini CLI、Copilot、Cline、Cursor、Windsurf，以及任何读取 <code>AGENTS.md</code> 的 harness。',
      footerBuilt: '作者 <a href="https://github.com/qxii2027">Qxii2027</a>',
      copy: '复制',
      copied: '已复制',
      select: '已选中'
    },
    en: {
      metaTitle: 'NoWheel — Don’t reinvent the wheel',
      metaDescription: 'NoWheel is an agent skill that makes AI ask before design decisions, use real icon libraries, and reuse proven open source.',
      heroLine1: 'Don’t reinvent',
      heroLine2: 'the <em>wheel</em>.',
      heroLead: 'NoWheel is an agent skill for interface work. It makes the agent ask before deciding, use real icon libraries, and reuse proven open source instead of rebuilding it.',
      btnDownload: 'Download',
      btnInstall: 'Install',
      sInstall: 'Install',
      downloadTitle: 'Download the latest release',
      stepNpx: 'From GitHub, no clone:',
      stepClone: 'Or clone and install:',
      fineInstall: 'Requires Node 18+. No npm install.',
      sChanges: 'What changes',
      askLabel: 'Ask',
      askTitle: 'Ask first.',
      askBody: 'Layout, motion, dependency, license. When a decision is genuinely open, the agent stops and presents options.',
      iconsLabel: 'Icons',
      iconsTitle: 'Use real icons.',
      iconsBody: 'It detects the icon set already installed, searches real ids, and fetches the official SVG. No hand-drawn paths, no guessed names.',
      reuseLabel: 'Reuse',
      reuseTitle: 'Reuse what works.',
      reuseBody: 'Complex features start with a search: stars, maintenance, license, source. Adapt a proven implementation instead of rebuilding one.',
      sHow: 'How it works',
      howText: 'One <code>SKILL.md</code> the harness loads. Three switches. Two zero-dependency Node tools.',
      flowTask: 'task',
      flowSwitches: 'switches',
      flowCode: 'code',
      howNote: 'The agent reads the switches, calls a tool only while its rule is on, and writes the result into your project. No daemon, no database, no install step.',
      sUse: 'Use',
      useLead: 'Restart the harness, then ask for interface work. The skill applies on its own.',
      stepToggle: 'Toggle the three rules:',
      stepIcons: 'Search real icons:',
      fineUse: 'Works in Claude Code, Codex, Gemini CLI, Copilot, Cline, Cursor, Windsurf, and anything that reads <code>AGENTS.md</code>.',
      footerBuilt: 'Built by <a href="https://github.com/qxii2027">Qxii2027</a>',
      copy: 'copy',
      copied: 'copied',
      select: 'select'
    }
  };

  var storedLang = null;
  try {
    storedLang = window.localStorage.getItem('nowheel-lang');
  } catch (error) {
    /* storage can be unavailable */
  }
  var currentLang = storedLang === 'en' ? 'en' : 'zh';

  function setMeta(attribute, name, content) {
    var element = document.querySelector('meta[' + attribute + '="' + name + '"]');
    if (element) element.setAttribute('content', content);
  }

  function label(key) {
    return (I18N[currentLang] && I18N[currentLang][key]) || key;
  }

  function applyLanguage(lang) {
    currentLang = I18N[lang] ? lang : 'zh';
    var dict = I18N[currentLang];

    document.documentElement.lang = currentLang === 'zh' ? 'zh-CN' : 'en';
    document.title = dict.metaTitle;
    setMeta('name', 'description', dict.metaDescription);
    setMeta('property', 'og:title', dict.metaTitle);
    setMeta('property', 'og:description', dict.metaDescription);

    document.querySelectorAll('[data-i18n]').forEach(function (element) {
      var value = dict[element.getAttribute('data-i18n')];
      if (value !== undefined) element.textContent = value;
    });

    document.querySelectorAll('[data-i18n-html]').forEach(function (element) {
      var value = dict[element.getAttribute('data-i18n-html')];
      if (value !== undefined) element.innerHTML = value;
    });

    document.querySelectorAll('.lang__btn').forEach(function (button) {
      button.setAttribute('aria-pressed', String(button.getAttribute('data-lang') === currentLang));
    });

    try {
      window.localStorage.setItem('nowheel-lang', currentLang);
    } catch (error) {
      /* storage can be unavailable */
    }

    if (window.ScrollTrigger) {
      window.requestAnimationFrame(function () {
        window.ScrollTrigger.refresh();
      });
    }
  }

  document.querySelectorAll('.lang__btn').forEach(function (button) {
    button.addEventListener('click', function () {
      applyLanguage(button.getAttribute('data-lang'));
    });
  });

  applyLanguage(currentLang);

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var gsap = window.gsap;

  document.querySelectorAll('.code').forEach(function (block) {
    var button = block.querySelector('.copy');
    var code = block.querySelector('code');
    if (!button || !code) return;
    button.setAttribute('aria-live', 'polite');

    button.addEventListener('click', function () {
      var text = code.textContent.trim();
      var done = function (key) {
        button.textContent = label(key);
        window.setTimeout(function () {
          button.textContent = label('copy');
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
