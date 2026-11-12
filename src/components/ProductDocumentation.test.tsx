import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
const state = vi.hoisted(() => ({ query: { isPending:false, isError:false, data:null as unknown } }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => state.query, queryOptions:(x:unknown)=>x }));
vi.mock("@/lib/technical/catalog", () => ({ productTechnicalQuery:(productId:string)=>({productId}) }));
import { ProductDocumentation } from "./ProductDocumentation";
const card={verified_on:"2026-11-12",review_status:"verified",sources:[{
  key:"manual",kind:"manual",publisher:"Производитель",model:"REAL ARC 200 (Z2K6)",
  title:"Руководство по эксплуатации",url:"https://svarog-rf.ru/files/manual.pdf",
  locator:"Модель на титульном листе",checked_on:"2026-11-12",sha256:""
}]};
afterEach(()=>{cleanup();state.query={isPending:false,isError:false,data:null};});
it("has a documentation section and no invented files when no source exists",()=>{
  render(<ProductDocumentation productId="product" />);
  expect(screen.getByRole("heading",{name:"Документация"})).toBeTruthy();
  expect(screen.queryAllByRole("link")).toHaveLength(0);
});
it("links the manufacturer document with its exact model",()=>{
  state.query.data=card;
  render(<ProductDocumentation productId="product" />);
  expect(screen.getByRole("link").getAttribute("rel")).toBe("noopener noreferrer");
  expect(screen.getByText(/REAL ARC 200/)).toBeTruthy();
});
it("removes cached links when a refresh fails",()=>{
  state.query.data=card;
  const view=render(<ProductDocumentation productId="product" />);
  expect(screen.queryAllByRole("link")).toHaveLength(1);
  state.query.isError=true;
  view.rerender(<ProductDocumentation productId="product" />);
  expect(screen.queryAllByRole("link")).toHaveLength(0);
  expect(screen.getByText(/сейчас недоступны/)).toBeTruthy();
});
