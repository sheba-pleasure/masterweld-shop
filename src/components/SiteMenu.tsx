import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { MasterWeldMark } from "@/components/icons/MasterWeldLogo";
import { CategoryWeldingIcon } from "@/components/icons/WeldingIcons";
import { categoriesQuery } from "@/lib/catalog";
import { CONTACTS } from "@/lib/contacts";
import { buildCategoryTree, toggleExpanded } from "@/lib/nav";

export function SiteMenu() {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const { data: cats = [] } = useQuery(categoriesQuery);
  const tree = buildCategoryTree(cats);
  const close = () => setOpen(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button type="button" aria-label="Открыть меню и каталог" className="emblem-btn">
          <span className="burger">
            <span />
            <span />
            <span />
          </span>
        </button>
      </SheetTrigger>
      <SheetContent
        side="left"
        className="menu-panel inset-y-3 left-3 h-auto w-[88vw] max-w-sm overflow-y-auto rounded-3xl border border-white/14 p-0 text-foreground"
      >
        <SheetHeader className="border-b border-white/10 px-5 py-4 text-left">
          <SheetTitle className="menu-label menu-label--title flex items-center gap-3 text-white">
            <MasterWeldMark size={28} className="shrink-0 text-white" />
            <span className="truncate">Мастер Сварщик</span>
          </SheetTitle>
        </SheetHeader>
        <nav className="flex flex-col gap-2 p-4">
          <Link
            to="/"
            search={{}}
            onClick={close}
            className="menu-pill menu-label flex min-h-11 items-center"
          >
            Главная
          </Link>
          <Link
            to="/"
            search={{}}
            hash="catalog"
            onClick={close}
            className="menu-pill menu-pill--accent menu-label flex min-h-11 items-center font-semibold"
          >
            Весь каталог
          </Link>
          <Link
            to="/contacts"
            onClick={close}
            className="menu-pill menu-label flex min-h-11 items-center"
          >
            Контакты
          </Link>

          <div className="my-2 h-px bg-white/10" />

          {tree.map(({ category: t, children: subs }) => {
            const isOpen = expanded === t.id;
            return (
              <div key={t.id}>
                <div className="menu-pill flex min-h-11 items-center gap-2 !py-1 !pl-3.5 !pr-1.5">
                  <CategoryWeldingIcon
                    slug={t.slug}
                    name={t.name}
                    size={16}
                    className="shrink-0 text-mw-cyan"
                  />
                  <Link
                    to="/"
                    search={{ cat: t.slug }}
                    hash="catalog"
                    onClick={close}
                    className="menu-label min-w-0 flex-1 py-2 text-foreground"
                  >
                    {t.name}
                  </Link>
                  {subs.length > 0 && (
                    <button
                      type="button"
                      aria-label={isOpen ? "Свернуть подразделы" : "Показать подразделы"}
                      aria-expanded={isOpen}
                      onClick={() => setExpanded((cur) => toggleExpanded(cur, t.id))}
                      className="menu-chevron flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
                    >
                      <ChevronDown
                        className={`h-4 w-4 transition-transform duration-150 ${isOpen ? "rotate-180" : ""}`}
                      />
                    </button>
                  )}
                </div>
                {isOpen && (
                  <div className="mt-1.5 flex flex-col gap-1.5 pl-4">
                    {subs.map((s) => (
                      <Link
                        key={s.id}
                        to="/"
                        search={{ cat: s.slug }}
                        hash="catalog"
                        onClick={close}
                        className="menu-pill menu-pill--sub menu-label menu-label--sub flex min-h-10 items-center gap-2"
                      >
                        <CategoryWeldingIcon
                          slug={s.slug}
                          name={s.name}
                          size={14}
                          className="shrink-0 text-muted-foreground"
                        />
                        <span>{s.name}</span>
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          <div className="mt-4 border-t border-white/10 pt-4">
            <a
              href={CONTACTS.phoneHref}
              className="block font-mono text-sm font-semibold text-white transition-colors duration-150 hover:text-mw-amber"
            >
              {CONTACTS.phoneDisplay}
            </a>
            <a
              href={`mailto:${CONTACTS.email}`}
              className="mt-1 block font-mono text-xs text-muted-foreground transition-colors duration-150 hover:text-mw-cyan"
            >
              {CONTACTS.email}
            </a>
          </div>
        </nav>
      </SheetContent>
    </Sheet>
  );
}
