# Quiz Sunucusu / Classroom Quiz Server

**🇹🇷 [Türkçe](#türkçe) · 🇬🇧 [English](#english)**

---

## Türkçe

Sınıf içi LAN üzerinden çalışan bir quiz uygulaması. Öğretmen kendi laptop'unda bir `.exe` çift tıklar, sunucu kalkar; öğrenciler aynı WiFi veya hotspot üzerinden QR kod / IP ile katılır. **İnternet, domain, hosting gerekmiyor.**

> **Not:** Bu projeyi tamamen AI (Claude Code) kullanarak yazdım. Kodu ben yazmadım, AI ile birlikte ürettim. Hoşuma gittiği ve birinin işine yarayabileceğini düşündüğüm için yayınlıyorum. Bir menfaatim yok, satmıyorum. İhtiyacı olan klonlasın, kullansın, fork etsin, istediği gibi değiştirsin. **Issue ve PR'lara yanıt vermeyi garanti edemem** — kendi yolunda devam edecek bir proje değil. Olduğu gibi kullanın.

### Ne işe yarıyor

- Öğretmen quiz oluşturur (çoktan seçmeli, doğru/yanlış, açık uçlu — resim de eklenebilir)
- "Başlat" der → 6 haneli kod + QR çıkar
- Öğrenciler kendi telefon/tablet'lerinden katılır
- Cevaplar canlı toplanır
- Otomatik puanlama (çoktan seçmeli + D/Y) + manuel puanlama (açık uçlu)
- Süre kontrolü: süresiz / toplam dakika / soru başına saniye
- Öğrenci numarası sistemi (6 hane, kayıt oturumuyla atanır)
- Hibrit mod: quiz sırasında da yeni öğrenci kabul

### Kimin için

- Sınıf-içi anlık değerlendirme yapmak isteyen öğretmenler
- Kahoot gibi hizmetler için ödeme yapamayan / yapmak istemeyen
- Okul WiFi yok / yavaş, kendi hotspot'unu açmaya hazır olan
- Veriyi bulutta tutmak istemeyen (her şey öğretmenin kendi cihazında kalır)

### Hızlı başlangıç (öğretmenler için)

1. **Releases** sekmesinden `QuizSunucusu.exe` indir
2. Masaüstüne koy, çift tıkla
3. Açılan tarayıcıdaki yönetim arayüzünden quiz oluştur
4. "Başlat" → ekrandaki QR'ı öğrencilere göster
5. Bitince sonuçları oku, açık uçluları puanla

Detaylı kullanım: [OKU-BENI.txt](kodlar/OKU-BENI.txt)

### Geliştiriciler için (kaynaktan çalıştırma)

```bash
git clone https://github.com/abdullaht1t/quiz-sunucusu.git
cd quiz-sunucusu/kodlar
npm install
npm start
```

Sonra:
- `http://localhost:3000/` — öğretmen yönetim paneli
- `http://<LAN-IP>:3000/` — öğrenci join sayfası

### Windows için `.exe` derleme

```bash
cd kodlar
npm install
npm run build:win
# Çıktı: kodlar/dist/QuizSunucusu.exe
```

Mac'ten Windows için cross-compile çalışıyor (sadece pure-JS bağımlılıklar var, native modül yok).

### Mimari

- **Server:** Node.js + Express + Socket.io + lowdb (JSON dosyası)
- **Frontend:** Vanilla JS SPA (build step yok, framework yok)
- **Paketleme:** [@yao-pkg/pkg](https://github.com/yao-pkg/pkg) ile tek `.exe` (Node 18 runtime bundle)

#### Veri saklama

- **Veri:** `data/quiz.db.json` (tek dosya, tüm quizler/oturumlar/öğrenciler/sonuçlar/loglar)
- **Resimler:** `data/uploads/*.png|jpg|webp|gif`
- `.exe`'nin yanında otomatik oluşur, `process.cwd()` referansıyla yazılır
- Yedeklemek için `data/` klasörünü kopyalamak yeterli

#### Güvenlik tasarımı

Bu uygulama **sınıf-içi LAN için** tasarlandı. İnternete açık bir sunucuda deploy etmek için ek sertleştirme gerekir.

Yönetim paneli (öğretmen tarafı), TCP socket'in **gerçek** kaynak IP'sine bakarak sadece `127.0.0.1`/`::1`'den gelen isteklere açılır. `X-Forwarded-For`, `Host` gibi başlıklar reddedilir (header spoof'a kapalı). Aynı LAN'daki öğrenci tarayıcı uzantısı veya `curl` ile bu yetkilendirmeyi aşamaz.

Ek katmanlar:
- HttpOnly cookie + `X-Student-Token` header ile IDOR koruması
- `express-rate-limit` (login 30/dk, register 20/dk, log 60/dk vb.)
- Magic-byte mime doğrulaması (yüklenen resimler için)
- CSV Excel formula injection koruması (`=+-@\t\r` ile başlayan hücreler kaçırılır)
- Prototype pollution koruması (`__proto__`, `constructor` reddi)
- Path traversal koruması (filename regex'i)

### Özellikler

- ✅ 3 soru tipi: çoktan seçmeli, doğru/yanlış, açık uçlu
- ✅ Sorularda ve şıklarda resim (max 2 MB, jpg/png/webp/gif)
- ✅ Süre modu: süresiz / toplam süre / soru başına
- ✅ Soru ve şık karıştırma (kopya zorlaştırma)
- ✅ Öğrenci numarası ile tek-tıkla giriş, isim+sınıf ile alternatif giriş
- ✅ Hibrit mod (quiz sırasında yeni kayıt)
- ✅ Aynı sınava 2. kez girme engeli (öğretmen sonucu silerek izin verir)
- ✅ Açık uçlu sorular için manuel puanlama (accordion arayüz)
- ✅ Tema sistemi (krem, koyu mor, koyu mavi, koyu yeşil, beyaz, pastel, yüksek kontrast + custom color picker)
- ✅ Log sistemi (Türkçe açıklamalı, filtreli)
- ✅ CSV export
- ✅ Mobile-friendly öğrenci arayüzü

### Yapılmayan / sınırlamalar

- **Çoklu sınıf paralel oturum yok** — tek aktif quiz (sınıf-içi senaryo için yeterli)
- **Bulut yedek yok** — yedek alma manuel (`data/` klasörünü kopyala)
- **i18n yok** — UI tamamen Türkçe (kod kolayca çevrilebilir, fork hoş geldiniz)
- **Mobile teacher mode yok** — yönetim sadece sunucu makinesinden
- **Resim crop / annotation yok** — yüklendiği gibi gösterilir
- **Audio/video soru yok** — sadece resim

### AI ile geliştirme notu

Bu projeyi Claude Code ile yazdım. Birkaç hafta süren bir konuşma silsilesi sonucu ortaya çıktı. Mimari kararları, güvenlik denetimi (kırmızı takım / mavi takım simülasyonu), UI testleri — hepsi konuşmayla yapıldı. Kodun nasıl evrildiğini merak edenler için: gerçek bir "AI ile bir şey yapmak" deneyiminin nasıl göründüğünü gösteren bir vaka.

Bu yüzden:
- Kod stiliyle ilgili sorular sormayın, ben de bilmiyorum
- Bir bölümün neden öyle yazıldığını sorarsanız tahmin yapabilirim ama tam cevap veremem
- Fork edip değiştirebilirsiniz, kendi AI'nızla iterate edebilirsiniz

### Lisans

MIT — istediğiniz gibi kullanın. [LICENSE](LICENSE) dosyasına bakın.

### Sorumluluk

Bu yazılım "olduğu gibi" sunulur. Veri kaybı, kullanım sırasında sınıfta yaşanan sorunlar vb. için sorumluluk almıyorum. Test ettim, kullanım için kararlı görünüyor, ama önemli sınavlar için yedek almayı / Kahoot gibi denenmiş bir araçla paralel test etmeyi öneririm.

### Katkı

Açığım — pull request gönderebilirsiniz. Ama:
- Yanıtlamayı garanti edemem
- Beklenmedik sürelerde kapanabilirim
- Çok büyük değişiklikleri merge etmem zor olur — fork açmayı tercih edebilirsiniz

İyi quizler.

---

## English

A LAN-based classroom quiz application. The teacher double-clicks an `.exe` on their laptop, the server starts up; students join via QR code or IP over the same WiFi or hotspot. **No internet, domain, or hosting required.**

> **Note:** I built this project entirely with AI (Claude Code). I didn't write the code myself — I co-produced it with the AI. Publishing it because I liked the result and thought it might be useful to someone. No commercial interest. Clone it, use it, fork it, modify it as you wish. **I can't guarantee responses to issues or PRs** — this isn't a project I plan to maintain actively. Use it as-is.
>
> **UI is in Turkish.** All strings, labels, and the admin panel are Turkish-only. Forks adding i18n are welcome.

### What it does

- Teacher creates a quiz (multiple choice, true/false, open-ended — images supported)
- Click "Başlat" (Start) → 6-digit code + QR generated
- Students join from their phones/tablets
- Answers collected in real time
- Auto-grading (MC + T/F) + manual grading (open-ended)
- Time control: unlimited / total time / per-question
- Student number system (6-digit, assigned via registration session)
- Hybrid mode: accept new students during a quiz

### Who it's for

- Teachers who want in-class instant assessment
- Anyone who can't / doesn't want to pay for Kahoot or similar
- Schools where WiFi is missing or slow (the teacher's phone hotspot works fine)
- People who don't want quiz data in the cloud (everything stays on the teacher's device)

### Quick start (for teachers)

1. Download `QuizSunucusu.exe` from the **Releases** tab
2. Put it on the desktop, double-click
3. Browser opens to the admin panel — create a quiz
4. Click "Başlat" → show the QR on the screen
5. Read answers afterwards, manually grade the open-ended ones

Detailed usage guide: [OKU-BENI.txt](kodlar/OKU-BENI.txt) (Turkish)

### For developers (running from source)

```bash
git clone https://github.com/abdullaht1t/quiz-sunucusu.git
cd quiz-sunucusu/kodlar
npm install
npm start
```

Then:
- `http://localhost:3000/` — teacher admin panel
- `http://<LAN-IP>:3000/` — student join page

### Building `.exe` for Windows

```bash
cd kodlar
npm install
npm run build:win
# Output: kodlar/dist/QuizSunucusu.exe
```

Cross-compilation from Mac/Linux to Windows works fine (only pure-JS dependencies, no native modules).

### Architecture

- **Server:** Node.js + Express + Socket.io + lowdb (JSON file)
- **Frontend:** Vanilla JS SPA (no build step, no framework)
- **Packaging:** [@yao-pkg/pkg](https://github.com/yao-pkg/pkg) bundles to single `.exe` (Node 18 runtime included)

#### Data storage

- **Data:** `data/quiz.db.json` (single file — all quizzes, sessions, students, results, logs)
- **Images:** `data/uploads/*.png|jpg|webp|gif`
- Auto-created next to the `.exe`, written using `process.cwd()`
- To back up: just copy the `data/` folder

#### Security design

This app is **designed for classroom LAN use**. Deploying to a public internet server requires additional hardening.

The admin panel (teacher side) is gated by the TCP socket's **actual** source IP, accepting only `127.0.0.1`/`::1` requests. Headers like `X-Forwarded-For` and `Host` are ignored (header spoofing closed). A student on the same LAN can't bypass this with a browser extension or `curl`.

Additional layers:
- HttpOnly cookie + `X-Student-Token` header for IDOR protection
- `express-rate-limit` (login 30/min, register 20/min, log 60/min, etc.)
- Magic-byte mime validation for uploaded images
- CSV Excel formula injection protection (cells starting with `=+-@\t\r` are escaped)
- Prototype pollution protection (`__proto__`, `constructor` rejected)
- Path traversal protection (filename regex)

### Features

- ✅ 3 question types: multiple choice, true/false, open-ended
- ✅ Images in questions and options (max 2 MB; jpg/png/webp/gif)
- ✅ Time modes: unlimited / total / per-question
- ✅ Question and option shuffling (anti-cheating)
- ✅ One-tap login via student number, fallback via name+class
- ✅ Hybrid mode (new registrations during a quiz)
- ✅ Re-entry blocked for the same quiz (teacher can delete a result to allow re-entry)
- ✅ Manual grading for open-ended questions (accordion UI)
- ✅ Theme system (cream, dark purple, dark blue, dark green, light, pastel, high contrast + custom color picker)
- ✅ Logging system (filtered, with Turkish messages)
- ✅ CSV export
- ✅ Mobile-friendly student UI

### What's not done / limitations

- **No multiple parallel sessions** — only one active quiz (sufficient for in-class scenario)
- **No cloud backup** — backup is manual (copy the `data/` folder)
- **No i18n** — UI is fully Turkish (easily translatable; forks welcome)
- **No mobile teacher mode** — admin panel only from the host machine
- **No image crop / annotation** — displayed as uploaded
- **No audio/video questions** — images only

### Note on AI development

I built this with Claude Code. It emerged from a conversation chain spanning a few weeks. Architecture decisions, security audits (red-team / blue-team simulation), UI tests — all done through conversation. For those curious how an "actually-built-with-AI" project evolves: this is a case study of what that looks like.

So:
- Don't ask me about code style choices — I don't know either
- If you ask why a section is written a certain way, I can guess but can't give a definitive answer
- Feel free to fork and iterate with your own AI

### License

MIT — use as you wish. See [LICENSE](LICENSE).

### Disclaimer

This software is provided "as is". I'm not liable for data loss, in-class issues, or anything else. I tested it and it seems stable, but for high-stakes exams I'd recommend a backup or running it alongside a more battle-tested tool like Kahoot.

### Contributing

Open to PRs. But:
- Can't guarantee responses
- May be unavailable for stretches
- Big changes are hard to merge — you may prefer to fork

Happy quizzing.
