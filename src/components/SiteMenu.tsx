import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { categoriesQuery } from "@/lib/catalog";
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
        <button
          type="button"
          aria-label="Открыть меню и каталог"
          className="emblem-btn group flex items-center rounded-full p-1.5"
        >
          <span className="burger flex h-10 w-10 flex-col items-center justify-center gap-[5px] rounded-full">
            <span />
            <span />
            <span />
          </span>
        </button>
      </SheetTrigger>
      <SheetContent
        side="left"
        className="menu-panel inset-y-3 left-3 h-auto w-[86vw] max-w-sm overflow-y-auto rounded-[2rem] border-2 border-brand-yellow/60 bg-brand-deep p-0 text-primary-foreground"
      >
        <SheetHeader className="p-5 pb-2">
          <SheetTitle className="menu-label menu-label--title flex min-w-0 items-center gap-3 text-brand-yellow">
            <span className="wordmark truncate text-[1.35rem]">Мастер Сварщик</span>
            <span className="shrink-0">Меню</span>
          </SheetTitle>
        </SheetHeader>
        <nav className="flex flex-col gap-2 p-4 pt-2">
          <Link
            to="/"
            search={{}}
            onClick={close}
            className="menu-pill menu-label flex min-h-12 items-center"
          >
            Главная
          </Link>
          <Link
            to="/"
            search={{}}
            onClick={close}
            className="menu-pill menu-pill--accent menu-label flex min-h-12 items-center"
          >
            Весь каталог
          </Link>
          <div className="my-1 h-px rounded-full bg-primary-foreground/10" />
          {tree.map(({ category: t, children: subs }) => {
            const isOpen = expanded === t.id;
            return (
              <div key={t.id}>
                <div className="menu-pill flex min-h-12 items-center gap-1 !py-1 !pl-4 !pr-1.5">
                  <Link
                    to="/"
                    search={{ cat: t.slug }}
                    onClick={close}
                    className="menu-label min-w-0 flex-1 py-2 text-primary-foreground"
                  >
                    {t.name}
                  </Link>
                  {subs.length > 0 && (
                    <button
                      type="button"
                      aria-label={isOpen ? "Свернуть подразделы" : "Показать подразделы"}
                      aria-expanded={isOpen}
                      onClick={() => setExpanded((cur) => toggleExpanded(cur, t.id))}
                      className="menu-chevron flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
                    >
                      <ChevronDown
                        className={`h-4 w-4 transition-transform ${isOpen ? "rotate-180" : ""}`}
                      />
                    </button>
                  )}
                </div>
                {isOpen && (
                  <div className="mt-2 flex flex-col gap-1.5 pl-4">
                    {subs.map((s) => (
                      <Link
                        key={s.id}
                        to="/"
                        search={{ cat: s.slug }}
                        onClick={close}
                        className="menu-pill menu-pill--sub menu-label menu-label--sub flex min-h-10 items-center"
                      >
                        {s.name}
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </nav>
      </SheetContent>
    </Sheet>
  );
}
