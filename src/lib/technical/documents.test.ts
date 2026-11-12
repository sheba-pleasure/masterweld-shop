import { expect, it } from "vitest";
import { productDocuments, type DocumentCard } from "./documents";
const source = { key: "manual", kind: "manual" as const, publisher: "Производитель",
  model: "Точная модель", title: "Паспорт", url: "https://svarog-rf.ru/files/test.pdf",
  locator: "Модель на титульном листе", checked_on: "2026-11-12", sha256: "" };
const card: DocumentCard = { verified_on: "2026-11-12", review_status:"verified", sources:[source] };
it("shows a reviewed exact-model source without claiming certificate validity", () => {
  expect(productDocuments(card)).toEqual([source]);
});
it("does not publish discovered but unreviewed sources", () => {
  expect(productDocuments({...card, verified_on:null, review_status:"manufacturer_source_unverified"})).toEqual([]);
  expect(productDocuments(null)).toEqual([]);
});
it("excludes supplier, research and synthetic sources even with PDF filenames", () => {
  for (const kind of ["supplier","research","synthetic"] as const)
    expect(productDocuments({...card,sources:[{...source,kind}]})).toEqual([]);
});
it("accepts manufacturer document pages but not ordinary product pages", () => {
  const manufacturer = {...source,kind:"manufacturer" as const};
  expect(productDocuments({...card,sources:[{...manufacturer,url:"https://svarog-rf.ru/products/model"}]})).toEqual([]);
  expect(productDocuments({...card,sources:[{...manufacturer,url:"https://svarog-rf.ru/docs/manual"}]})).toHaveLength(1);
  expect(productDocuments({...card,sources:[{...manufacturer,url:"https://svarog-rf.ru/files/testxpdf"}]})).toEqual([]);
});
it("deduplicates the same URL without combining model identities", () => {
  expect(productDocuments({...card,sources:[source,{...source,key:"second"}]})).toHaveLength(1);
});
it("rejects unsafe, authenticated and token-bearing URLs", () => {
  for (const url of ["javascript:alert(1)","http://svarog-rf.ru/a.pdf","https://user:pass@svarog-rf.ru/a.pdf","https://svarog-rf.ru/a.pdf?token=x","https://svarog-rf.ru/a.pdf#x",""])
    expect(productDocuments({...card,sources:[{...source,url}]})).toEqual([]);
});
