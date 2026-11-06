import { SiteMenu } from "@/components/SiteMenu";
import { SiteActions } from "@/components/SiteActions";
import { SiteFooter } from "@/components/SiteFooter";
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
import { MapPin } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { CONTACTS } from "@/lib/contacts";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: ErrorComponentProps) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
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
    <html lang="ru">
      <head>
        <HeadContent />
      </head>
      <body className="font-sans antialiased">
        {children}
        <Scripts />
      </body>
    </html>
  );
}

/** Поиск в шапке: на больших экранах — поле, на телефоне — кнопка к поиску на витрине. */
function HeaderSearch() {
  const navigate = useNavigate();
  const [value, setValue] = useState("");
  const go = () => navigate({ to: "/", search: { q: value.trim() || undefined } });
  return (
    <>
      <form
        role="search"
        className="hidden lg:block"
        onSubmit={(e) => {
          e.preventDefault();
          go();
        }}
      >
        <input
          type="search"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Модель, артикул, бренд…"
          aria-label="Поиск по каталогу: модель, артикул или бренд"
          className="menu-field w-48"
        />
      </form>
    </>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  return (
    <QueryClientProvider client={queryClient}>
      {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
      {import.meta.env.VITE_APP_ENV === "dev" && (
        <div
          role="note"
          className="bg-amber-300 px-4 py-2 text-center text-sm leading-relaxed text-slate-950"
        >
          <strong>Тестовый магазин · DEV.</strong> Здесь можно пробовать. Товары и заказы учебные,
          покупки не отправляются.
        </div>
      )}
      <header className="sticky top-0 z-20 border-b-2 border-brand-yellow bg-brand-deep backdrop-blur">
        <div className="mx-auto grid max-w-7xl grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-2">
          <div className="flex min-w-0 items-center gap-3">
            <SiteMenu />
            <Link to="/" className="wordmark shrink-0" aria-label="Мастер Сварщик — на главную">
              Мастер Сварщик
            </Link>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <HeaderSearch />
            <a
              href={CONTACTS.maps}
              target="_blank"
              rel="noopener noreferrer"
              className="head-btn"
              aria-label="Где мы находимся — открыть Яндекс.Карты"
            >
              <MapPin className="h-4 w-4" strokeWidth={2.4} />
              <span className="hidden xl:inline">Где мы находимся</span>
            </a>
            <SiteActions />
          </div>
        </div>
      </header>
      <Outlet />
      <SiteFooter />
    </QueryClientProvider>
  );
}
