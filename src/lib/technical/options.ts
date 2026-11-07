// Human-facing choices share canonical codes with the catalog. Only exact, explicit
// names are accepted; this is not fuzzy matching or automatic source extraction.
const choices: Record<string, Record<string, { label: string; names: string[] }>> = {
  tig_polarity_modes: {
    dc: { label: "DC — постоянный ток", names: ["Постоянный ток"] },
    ac: { label: "AC — переменный ток", names: ["Переменный ток"] },
  },
  tig_start_modes: {
    hf: { label: "HF — бесконтактный поджиг", names: ["Бесконтактный поджиг"] },
    lift: { label: "Lift — поджиг касанием с отрывом", names: ["Поджиг касанием с отрывом"] },
    contact: { label: "Контактный поджиг", names: ["Контактный поджиг"] },
  },
  flux_wire_gas_mode: {
    self_shielded: { label: "Самозащитная", names: ["Самозащитная"] },
    gas_shielded: { label: "С защитным газом", names: ["С защитным газом"] },
  },
  cooling: {
    air: { label: "Воздушное", names: ["Воздушное"] },
    liquid: { label: "Жидкостное", names: ["Жидкостное"] },
  },
};
const normalize = (value: string) => value.trim().toLocaleLowerCase("ru-RU").replace(/ё/g, "е");

export function technicalOptionLabel(attribute: string, code: string): string {
  return choices[attribute]?.[code]?.label ?? code;
}

export function parseTechnicalOption(
  attribute: string,
  value: string,
  allowed: readonly string[],
): string | undefined {
  const answer = normalize(value);
  const matches = allowed.filter((code) => {
    const choice = choices[attribute]?.[code];
    return [code, ...(choice ? [choice.label, ...choice.names] : [])].some(
      (name) => normalize(name) === answer,
    );
  });
  return matches.length === 1 ? matches[0] : undefined;
}

export function technicalOptionsHelp(attribute: string, allowed: readonly string[]): string {
  return allowed.length
    ? "\nВарианты:\n" +
        allowed.map((code) => "• " + technicalOptionLabel(attribute, code)).join("\n")
    : "";
}
