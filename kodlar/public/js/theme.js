// Quiz uygulaması — tema yöneticisi
// HEAD'de inline script tema attribute'unu hemen uygular (flash önler);
// bu dosya admin tarafında settings sayfasının arka planı.

(function () {
  // FOIT/FOUC önleyici: ilk paint öncesi tema uygula
  var t = localStorage.getItem('quizTheme') || 'krem';
  document.documentElement.setAttribute('data-theme', t);
  if (t === 'custom') {
    try {
      var c = JSON.parse(localStorage.getItem('quizCustomColors') || '{}');
      Object.keys(c).forEach(function (k) {
        document.documentElement.style.setProperty(k, c[k]);
      });
    } catch (e) { /* ignore */ }
  }
})();

window.Theme = {
  DEFAULT: 'krem',
  PRESETS: [
    { id: 'krem',        label: 'Krem & Turkuaz',  hint: 'göz yormaz, varsayılan' },
    { id: 'dark-purple', label: 'Koyu Mor',        hint: 'derin, klasik' },
    { id: 'dark-blue',   label: 'Koyu Mavi',       hint: 'kurumsal' },
    { id: 'dark-green',  label: 'Koyu Yeşil',      hint: 'orman' },
    { id: 'light',       label: 'Beyaz Sade',      hint: 'minimal' },
    { id: 'pastel',      label: 'Pastel',          hint: 'şeker' },
    { id: 'hc',          label: 'Yüksek Kontrast', hint: 'erişilebilirlik' }
  ],
  current: function () { return localStorage.getItem('quizTheme') || this.DEFAULT; },
  apply: function (name, customColors) {
    document.documentElement.setAttribute('data-theme', name);
    localStorage.setItem('quizTheme', name);

    // Eski custom override'ları temizle
    var customVars = ['--bg-1', '--bg-2', '--panel', '--panel-2', '--panel-3',
      '--accent', '--accent-2', '--text', '--muted', '--border'];
    customVars.forEach(function (v) {
      document.documentElement.style.removeProperty(v);
    });

    if (name === 'custom' && customColors) {
      Object.keys(customColors).forEach(function (k) {
        document.documentElement.style.setProperty(k, customColors[k]);
      });
      localStorage.setItem('quizCustomColors', JSON.stringify(customColors));
    }
    window.dispatchEvent(new CustomEvent('themechange', { detail: { name: name } }));
  },
  getCustom: function () {
    try { return JSON.parse(localStorage.getItem('quizCustomColors') || '{}'); }
    catch (e) { return {}; }
  }
};
