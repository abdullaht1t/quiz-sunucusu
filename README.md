# Quiz Sunucusu

Sınıf içi LAN üzerinden çalışan bir quiz uygulaması. Öğretmen kendi laptop'unda bir `.exe` çift tıklar, sunucu kalkar; öğrenciler aynı WiFi veya hotspot üzerinden QR kod / IP ile katılır. **İnternet, domain, hosting gerekmiyor.**

> **Not:** Bu projeyi tamamen AI (Claude Code) kullanarak yazdım. Kodu ben yazmadım, AI ile birlikte ürettim. Hoşuma gittiği ve birinin işine yarayabileceğini düşündüğüm için yayınlıyorum. Bir menfaatim yok, satmıyorum. İhtiyacı olan klonlasın, kullansın, fork etsin, istediği gibi değiştirsin. **Issue ve PR'lara yanıt vermeyi garanti edemem** — kendi yolunda devam edecek bir proje değil. Olduğu gibi kullanın.

---

## Ne işe yarıyor

- Öğretmen quiz oluşturur (çoktan seçmeli, doğru/yanlış, açık uçlu — resim de eklenebilir)
- "Başlat" der → 6 haneli kod + QR çıkar
- Öğrenciler kendi telefon/tablet'lerinden katılır
- Cevaplar canlı toplanır
- Otomatik puanlama (çoktan seçmeli + D/Y) + manuel puanlama (açık uçlu)
- Süre kontrolü: süresiz / toplam dakika / soru başına saniye
- Öğrenci numarası sistemi (6 hane, kayıt oturumuyla atanır)
- Hibrit mod: quiz sırasında da yeni öğrenci kabul

## Kimin için

- Sınıf-içi anlık değerlendirme yapmak isteyen öğretmenler
- Kahoot gibi hizmetler için ödeme yapamayan / yapmak istemeyen
- Okul WiFi yok / yavaş, kendi hotspot'unu açmaya hazır olan
- Veriyi bulutta tutmak istemeyen (her şey öğretmenin kendi cihazında kalır)

## Hızlı başlangıç (öğretmenler için)

1. **Releases** sekmesinden `QuizSunucusu.exe` indir
2. Masaüstüne koy, çift tıkla
3. Açılan tarayıcıdaki yönetim arayüzünden quiz oluştur
4. "Başlat" → ekrandaki QR'ı öğrencilere göster
5. Bitince sonuçları oku, açık uçluları puanla

Detaylı kullanım: [OKU-BENI.txt](OKU-BENI.txt)

## Geliştiriciler için (kaynaktan çalıştırma)

```bash
git clone https://github.com/abdullaht1t/quiz-sunucusu.git
cd quiz-sunucusu/kodlar
npm install
npm start
```

Sonra:
- `http://localhost:3000/` — öğretmen yönetim paneli
- `http://<LAN-IP>:3000/` — öğrenci join sayfası

## Windows için `.exe` derleme

```bash
cd kodlar
npm install
npm run build:win
# Çıktı: kodlar/dist/QuizSunucusu.exe
```

Mac'ten Windows için cross-compile çalışıyor (sadece pure-JS bağımlılıklar var, native modül yok).

## Mimari

- **Server:** Node.js + Express + Socket.io + lowdb (JSON dosyası)
- **Frontend:** Vanilla JS SPA (build step yok, framework yok)
- **Paketleme:** [@yao-pkg/pkg](https://github.com/yao-pkg/pkg) ile tek `.exe` (Node 18 runtime bundle)

### Veri saklama

- **Veri:** `data/quiz.db.json` (tek dosya, tüm quizler/oturumlar/öğrenciler/sonuçlar/loglar)
- **Resimler:** `data/uploads/*.png|jpg|webp|gif`
- `.exe`'nin yanında otomatik oluşur, `process.cwd()` referansıyla yazılır
- Yedeklemek için `data/` klasörünü kopyalamak yeterli

### Güvenlik tasarımı

Bu uygulama **sınıf-içi LAN için** tasarlandı. İnternete açık bir sunucuda deploy etmek için ek sertleştirme gerekir.

Yönetim paneli (öğretmen tarafı), TCP socket'in **gerçek** kaynak IP'sine bakarak sadece `127.0.0.1`/`::1`'den gelen isteklere açılır. `X-Forwarded-For`, `Host` gibi başlıklar reddedilir (header spoof'a kapalı). Aynı LAN'daki öğrenci tarayıcı uzantısı veya `curl` ile bu yetkilendirmeyi aşamaz.

Ek katmanlar:
- HttpOnly cookie + `X-Student-Token` header ile IDOR koruması
- `express-rate-limit` (login 30/dk, register 20/dk, log 60/dk vb.)
- Magic-byte mime doğrulaması (yüklenen resimler için)
- CSV Excel formula injection koruması (`=+-@\t\r` ile başlayan hücreler kaçırılır)
- Prototype pollution koruması (`__proto__`, `constructor` reddi)
- Path traversal koruması (filename regex'i)

## Özellikler

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

## Yapılmayan / sınırlamalar

- **Çoklu sınıf paralel oturum yok** — tek aktif quiz (sınıf-içi senaryo için yeterli)
- **Bulut yedek yok** — yedek alma manuel (`data/` klasörünü kopyala)
- **i18n yok** — UI tamamen Türkçe
- **Mobile teacher mode yok** — yönetim sadece sunucu makinesinden
- **Resim crop / annotation yok** — yüklendiği gibi gösterilir
- **Audio/video soru yok** — sadece resim

## AI ile geliştirme notu

Bu projeyi Claude Code ile yazdım. Birkaç hafta süren bir konuşma silsilesi sonucu ortaya çıktı. Mimari kararları, güvenlik denetimi (kırmızı takım / mavi takım simülasyonu), UI testleri — hepsi konuşmayla yapıldı. Kodun nasıl evrildiğini merak edenler için: gerçek bir "AI ile bir şey yapmak" deneyiminin nasıl göründüğünü gösteren bir vaka.

Bu yüzden:
- Kod stiliyle ilgili sorular sormayın, ben de bilmiyorum
- Bir bölümün neden öyle yazıldığını sorarsanız tahmin yapabilirim ama tam cevap veremem
- Fork edip değiştirebilirsiniz, kendi AI'nızla iterate edebilirsiniz

## Lisans

MIT — istediğiniz gibi kullanın. [LICENSE](LICENSE) dosyasına bakın.

## Sorumluluk

Bu yazılım "olduğu gibi" sunulur. Veri kaybı, kullanım sırasında sınıfta yaşanan sorunlar vb. için sorumluluk almıyorum. Test ettim, kullanım için kararlı görünüyor, ama önemli sınavlar için yedek almayı / Kahoot gibi denenmiş bir araçla paralel test etmeyi öneririm.

## Katkı

Açığım — pull request gönderebilirsiniz. Ama:
- Yanıtlamayı garanti edemem
- Beklenmedik sürelerde kapanabilirim
- Çok büyük değişiklikleri merge etmem zor olur — fork açmayı tercih edebilirsiniz

İyi quizler.
