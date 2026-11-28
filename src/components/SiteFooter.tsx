import { Link } from "@tanstack/react-router";
import { Phone } from "lucide-react";
import emblem from "@/assets/brand/master_svarshchik_3d_256px.png";
import { CONTACTS } from "@/lib/contacts";

export function SiteFooter() {
  return (
    <footer className="relative mt-20 overflow-hidden border-t border-white/10 bg-mw-surface/95 text-foreground">
      <div className="relative mx-auto max-w-7xl px-4 py-12 sm:px-6">
        <div className="flex flex-col gap-5 border-b border-white/10 pb-8 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex items-center gap-4">
            <img
              src={emblem}
              alt="Мастер Сварщик"
              width={80}
              height={44}
              className="h-auto w-20 shrink-0"
            />
            <p className="foot-slogan text-white">
              <span className="text-mw-amber">Качество</span> — самое главное!
            </p>
          </div>
          <nav
            aria-label="Навигация в подвале"
            className="flex flex-wrap items-center gap-6 text-sm text-muted-foreground"
          >
            <Link to="/" className="transition-colors duration-150 hover:text-white">
              Каталог
            </Link>
            <Link to="/contacts" className="transition-colors duration-150 hover:text-mw-cyan">
              Контакты
            </Link>
            <a
              href={CONTACTS.maps}
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors duration-150 hover:text-white"
            >
              Яндекс.Карты
            </a>
          </nav>
        </div>

        <div className="mt-8 flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
          <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
            Основан в <span className="font-mono font-medium text-white">1993</span> году. Товарный
            знак зарегистрирован в <span className="font-mono font-medium text-white">2002</span> г.
            и действует на всей территории РФ. Работаем уже более{" "}
            <span className="font-mono font-medium text-mw-amber">30 лет</span>! Доставка по всей
            России и СНГ.
          </p>

          <div className="flex flex-col gap-1.5 font-mono text-sm">
            <a
              href={CONTACTS.phoneHref}
              className="font-semibold text-white transition-colors duration-150 hover:text-mw-amber"
            >
              {CONTACTS.phoneDisplay}
            </a>
            <a
              href={`mailto:${CONTACTS.email}`}
              className="text-muted-foreground transition-colors duration-150 hover:text-mw-cyan"
            >
              {CONTACTS.email}
            </a>
          </div>

          <div className="flex items-center gap-2">
            <a
              href={CONTACTS.telegram}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Telegram"
              className="foot-btn"
            >
              <span className="foot-ico foot-ico--tg" />
            </a>
            <a
              href={CONTACTS.maps}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Яндекс.Карты"
              className="foot-btn"
            >
              <span className="foot-ico foot-ico--maps" />
            </a>
            <a
              href={CONTACTS.vk}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="ВКонтакте"
              className="foot-btn"
            >
              <span className="foot-ico foot-ico--vk" />
            </a>
            <a href={`mailto:${CONTACTS.email}`} aria-label="Написать письмо" className="foot-btn">
              <span className="foot-ico foot-ico--mail" />
            </a>
            <a href={CONTACTS.phoneHref} aria-label="Позвонить" className="foot-btn foot-btn--call">
              <Phone className="h-4 w-4" strokeWidth={2.2} />
            </a>
          </div>
        </div>

        <div className="mt-8 flex flex-wrap items-center justify-between gap-4 border-t border-white/10 pt-6 text-xs text-muted-foreground">
          <div className="flex items-center gap-3">
            <img
              src={emblem}
              alt="Мастер Сварщик"
              width={256}
              height={142}
              className="h-7 w-auto"
            />
            <span>© MasterWeld · Мастер Сварщик, Москва</span>
          </div>
          <span className="font-mono text-[11px] text-white/40">EST. 1993 // MSK</span>
        </div>
      </div>
    </footer>
  );
}
