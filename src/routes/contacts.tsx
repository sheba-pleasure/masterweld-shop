import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import { MagneticWrap, SpotlightBezel } from "@/components/MagneticWrap";
import { CrosshairIcon } from "@/components/icons/WeldingIcons";
import { CONTACTS } from "@/lib/contacts";

export const Route = createFileRoute("/contacts")({
  head: () => ({
    meta: [
      { title: "Контакты — интернет-магазин «Мастер Сварщик»" },
      {
        name: "description",
        content: `Контакты интернет-магазина «Мастер Сварщик» в Москве: телефон ${CONTACTS.phoneDisplay}, почта ${CONTACTS.email}, Telegram и схема проезда на Яндекс.Картах.`,
      },
    ],
  }),
  component: ContactsPage,
});

function ContactsPage() {
  return (
    <main className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
      <nav aria-label="Хлебные крошки" className="mb-4 font-mono text-xs text-muted-foreground">
        <Link to="/" className="transition-colors duration-150 hover:text-white">
          Главная
        </Link>{" "}
        / <span className="text-mw-cyan">Контакты</span>
      </nav>

      <div className="max-w-3xl">
        <div className="mb-3 inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.22em] text-mw-amber">
          <CrosshairIcon size={14} className="text-mw-cyan" />
          <span>МОСКВА // РФ И СНГ</span>
        </div>
        <h1 className="font-display text-3xl font-bold text-white sm:text-5xl">
          Контакты «Мастер Сварщик»
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-secondary-foreground sm:text-base">
          Работаем с 1993 года, товарный знак зарегистрирован в 2002 г. Уточняйте наличие, подбор
          оборудования, условия оплаты и доставку по России и СНГ.
        </p>
      </div>

      <div className="mt-8 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
        <SpotlightBezel innerClassName="flex h-full flex-col justify-between p-6">
          <div>
            <p className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
              Телефон
            </p>
            <a
              href={CONTACTS.phoneHref}
              className="mt-2 block font-display text-xl font-bold text-white transition-colors duration-150 hover:text-mw-amber tabular-nums"
            >
              {CONTACTS.phoneDisplay}
            </a>
            <p className="mt-2 text-sm text-muted-foreground">
              Подбор позиций, проверка наличия и оформление заказа по телефону.
            </p>
          </div>
          <div className="mt-6">
            <MagneticWrap>
              <a href={CONTACTS.phoneHref} className="btn-pill-cta">
                <span>Позвонить</span>
                <span className="btn-pill-icon" aria-hidden="true">
                  <ArrowUpRight className="h-4 w-4" />
                </span>
              </a>
            </MagneticWrap>
          </div>
        </SpotlightBezel>

        <SpotlightBezel innerClassName="flex h-full flex-col justify-between p-6">
          <div>
            <p className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
              Электронная почта
            </p>
            <a
              href={`mailto:${CONTACTS.email}`}
              className="mt-2 block break-all font-display text-xl font-bold text-white transition-colors duration-150 hover:text-mw-cyan"
            >
              {CONTACTS.email}
            </a>
            <p className="mt-2 text-sm text-muted-foreground">
              Спецификации, списки позиций и запросы по условиям поставки.
            </p>
          </div>
          <a href={`mailto:${CONTACTS.email}`} className="btn-pill-secondary mt-6 w-fit">
            Написать письмо
          </a>
        </SpotlightBezel>

        <SpotlightBezel innerClassName="flex h-full flex-col justify-between p-6">
          <div>
            <p className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
              Расположение
            </p>
            <p className="mt-2 font-display text-xl font-bold text-white">Москва</p>
            <p className="mt-2 text-sm text-muted-foreground">
              Адрес, схема проезда и график работы указаны в карточке на Яндекс.Картах.
            </p>
          </div>
          <a
            href={CONTACTS.maps}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-pill-secondary mt-6 w-fit"
          >
            <span>Открыть Яндекс.Карты</span>
            <ArrowUpRight className="h-4 w-4 text-mw-cyan" aria-hidden="true" />
          </a>
        </SpotlightBezel>
      </div>

      <SpotlightBezel
        className="mt-6"
        innerClassName="grid gap-6 p-6 sm:p-8 lg:grid-cols-2 lg:items-center"
      >
        <div>
          <h2 className="font-display text-2xl font-bold text-white">Telegram и ВКонтакте</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Напишите модель, артикул или задачу. Сотрудник подскажет подходящие позиции и согласует
            условия получения. Онлайн-оплата на сайте пока не подключена.
          </p>
        </div>
        <div className="flex flex-wrap gap-3 lg:justify-end">
          <MagneticWrap>
            <a
              href={CONTACTS.telegram}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-pill-cta"
            >
              <span>Открыть Telegram</span>
              <span className="btn-pill-icon" aria-hidden="true">
                <ArrowUpRight className="h-4 w-4" />
              </span>
            </a>
          </MagneticWrap>
          <a
            href={CONTACTS.vk}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-pill-secondary"
          >
            <span>ВКонтакте</span>
            <ArrowUpRight className="h-4 w-4 text-mw-cyan" aria-hidden="true" />
          </a>
          <Link to="/" hash="catalog" className="btn-pill-secondary">
            Перейти в каталог
          </Link>
        </div>
      </SpotlightBezel>
    </main>
  );
}
