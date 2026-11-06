import { Phone } from "lucide-react";
import emblem from "@/assets/brand/master_svarshchik_3d_256px.png";
import { CONTACTS } from "@/lib/contacts";

export function SiteFooter() {
  return (
    <footer className="mt-16 border-t-2 border-brand-yellow bg-brand-deep text-primary-foreground">
      <div className="mx-auto max-w-7xl px-4 py-10">
        <p className="foot-slogan">
          <span className="text-brand-yellow">Качество</span> — самое главное!
        </p>
        <div className="foot-rule" aria-hidden="true" />

        <div className="mt-7 flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
          <p className="max-w-xl text-sm leading-relaxed text-primary-foreground/70">
            Основан в <span className="font-semibold text-brand-yellow">1993</span> году. Товарный
            знак зарегистрирован в <span className="font-semibold text-brand-yellow">2002</span> г.
            и действует на всей территории РФ. Работаем уже более{" "}
            <span className="font-semibold text-brand-yellow">30 лет</span>! Доставка по всей России
            и СНГ.
          </p>

          <div className="flex flex-col gap-1 text-sm text-primary-foreground/70">
            <a href={CONTACTS.phoneHref} className="transition-colors hover:text-brand-yellow">
              {CONTACTS.phoneDisplay}
            </a>
            <a
              href={`mailto:${CONTACTS.email}`}
              className="transition-colors hover:text-brand-yellow"
            >
              {CONTACTS.email}
            </a>
          </div>

          <div className="flex items-center gap-3">
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
              <Phone className="h-6 w-6" strokeWidth={2.2} />
            </a>
          </div>
        </div>

        <div className="mt-8 flex items-center gap-3 border-t border-primary-foreground/10 pt-4 text-xs text-primary-foreground/50">
          <img
            src={emblem}
            alt="Мастер Сварщик"
            width={256}
            height={142}
            className="h-7 w-auto"
          />
          <span>© MasterWeld · Мастер Сварщик, Москва</span>
        </div>
      </div>
    </footer>
  );
}
