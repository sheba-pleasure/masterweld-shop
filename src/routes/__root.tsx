import { ArcIgnitionLoader } from "@/components/ArcIgnitionLoader";
import originalLogo from "@/assets/brand/master_svarshchik_3d_256px.png";
import { SiteMenu } from "@/components/SiteMenu";
import { TelegramShopBridge } from "@/components/TelegramShopBridge";
import { SiteActions } from "@/components/SiteActions";
import { SiteFooter } from "@/components/SiteFooter";
import { WeldingChrome } from "@/components/WeldingCursor";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useNavigate,
  useRouter,
  HeadContent,
  Scripts,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { MapPin, Search } from "lucide-react";
import { useState, type ReactNode } from "react";
import { CONTACTS } from "@/lib/contacts";

import appCss from "../styles.css?url";

function NotFoundComponent() {
  return (
    <div className="flex min-h-[70vh] items-center justify-center px-4">
      <div className="bezel-outer w-full max-w-md">
        <div className="bezel-inner p-8 text-center">
          <h1 className="font-display text-6xl font-semibold text-white">404</h1>
          <h2 className="mt-3 text-xl font-semibold text-white">Страница не найдена</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Проверьте адрес или вернитесь в каталог, чтобы найти нужный товар.
          </p>
          <div className="mt-6">
            <Link to="/" className="btn-pill-secondary">
              В каталог
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: ErrorComponentProps) {
  console.error(error);
  const router = useRouter();

  return (
    <div className="flex min-h-[70vh] items-center justify-center px-4">
      <div className="bezel-outer w-full max-w-md">
        <div className="bezel-inner p-8 text-center">
          <h1 className="font-display text-xl font-semibold tracking-tight text-white">
            Не удалось открыть страницу
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Попробуйте ещё раз или вернитесь в каталог. Если вы уже отправили заказ, проверьте его
            результат в корзине.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <button
              type="button"
              onClick={() => {
                router.invalidate();
                reset();
              }}
              className="btn-pill-secondary border-mw-amber/50 text-white"
            >
              Попробовать ещё раз
            </button>
            <a href="/" className="btn-pill-secondary">
              В каталог
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Интернет-магазин «Мастер Сварщик»" },
      {
        name: "description",
        content: "Интернет-магазин «Мастер Сварщик»: сварочное оборудование и расходники.",
      },
      { name: "robots", content: "noindex, nofollow" },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
      { rel: "icon", href: "/favicon-32x32.png", type: "image/png", sizes: "32x32" },
      { rel: "icon", href: "/favicon-16x16.png", type: "image/png", sizes: "16x16" },
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="ru" className="dark">
      <head>
        <HeadContent />
      </head>
      <body className="font-sans antialiased selection:bg-mw-amber selection:text-white">
        {children}
        <Scripts />
      </body>
    </html>
  );
}

/** Поиск в шапке: на больших экранах — поле, на телефоне — поиск сразу на витрине. */
function HeaderSearch() {
  const navigate = useNavigate();
  const [value, setValue] = useState("");
  const go = () => navigate({ to: "/", search: { q: value.trim() || undefined }, hash: "catalog" });
  return (
    <form
      role="search"
      className="relative hidden lg:block"
      onSubmit={(e) => {
        e.preventDefault();
        go();
      }}
    >
      <Search
        className="pointer-events-none absolute left-3.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-mw-cyan"
        aria-hidden="true"
      />
      <input
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Модель, артикул, бренд…"
        aria-label="Поиск по каталогу: модель, артикул или бренд"
        className="menu-field menu-field--search w-56 text-xs"
      />
    </form>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  return (
    <QueryClientProvider client={queryClient}>
      <ArcIgnitionLoader />
      <WeldingChrome />
      <TelegramShopBridge />
      {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
      {import.meta.env["VITE_APP_ENV"] === "dev" && (
        <div
          role="note"
          className="border-b border-mw-amber/30 bg-mw-amber/12 px-4 py-2 text-center text-xs leading-relaxed text-amber-100 sm:text-sm"
        >
          <strong className="font-mono font-semibold text-mw-amber">Тестовый магазин · DEV.</strong>{" "}
          Здесь можно пробовать. Товары и заказы учебные, покупки не отправляются.
        </div>
      )}
      <div className="sticky top-0 z-30 px-3 pt-3 sm:px-6">
        <header className="glass-pill mx-auto max-w-7xl rounded-full px-2.5 py-2 sm:px-4">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 sm:gap-3">
            <div className="flex min-w-0 items-center gap-2 sm:gap-3.5">
              <SiteMenu />
              <Link
                to="/"
                className="group flex min-w-0 items-center gap-2.5"
                aria-label="Мастер Сварщик — на главную"
              >
                <img
                  src={originalLogo}
                  alt="Мастер Сварщик"
                  width={96}
                  height={53}
                  className="h-10 w-auto shrink-0 object-contain sm:h-12"
                />
              </Link>
              <nav
                aria-label="Основная навигация"
                className="ml-3 hidden items-center gap-6 text-xs font-semibold text-muted-foreground md:flex"
              >
                <Link
                  to="/"
                  hash="catalog"
                  className="transition-colors duration-150 hover:text-white"
                >
                  Каталог
                </Link>
                <Link to="/contacts" className="transition-colors duration-150 hover:text-mw-cyan">
                  Контакты
                </Link>
              </nav>
            </div>
            <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
              <HeaderSearch />
              <a
                href={CONTACTS.maps}
                target="_blank"
                rel="noopener noreferrer"
                className="head-btn hidden sm:inline-flex"
                aria-label="Где мы находимся — открыть Яндекс.Карты"
              >
                <MapPin className="h-4 w-4 text-mw-cyan" strokeWidth={2} />
                <span className="hidden xl:inline">Где мы находимся</span>
              </a>
              <SiteActions />
            </div>
          </div>
        </header>
      </div>
      <Outlet />
      <SiteFooter />
    </QueryClientProvider>
  );
}
