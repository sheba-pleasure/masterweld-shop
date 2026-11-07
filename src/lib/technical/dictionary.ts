import pilot from "./pilot-dictionary.json";
import consumables from "./consumable-dictionary.json";

// Append only: existing persisted editor buttons address families and fields by index.
// Keep the 0017 pilot immutable; SQL upgrades add the same extension without rewriting facts.
const supported = (code: string) => pilot.bindings.some((b) => b.family_code === code);
const dictionary = {
  units: [...pilot.units, ...consumables.units],
  families: [
    ...pilot.families.filter((f) => supported(f.code)),
    ...pilot.families.filter(
      (f) => !supported(f.code) && consumables.bindings.some((b) => b.family_code === f.code),
    ),
  ],
  attributes: [...pilot.attributes, ...consumables.attributes],
  bindings: [...pilot.bindings, ...consumables.bindings],
};
export default dictionary;

export function consumableGuidance(family: string): string {
  if (!consumables.bindings.some((b) => b.family_code === family)) return "";
  return "📎 Сверяйте точную модификацию и упаковку по документу. Размер сам по себе не подтверждает совместимость. Если сведений нет, выберите «Нет подтверждённых сведений». Список полей пока неполный.";
}

export function attributeGuidance(code: string): string {
  if (code === "tig_cup_size")
    return "Это номер размера сопла по документу, а не диаметр в миллиметрах. Не пересчитывайте его самостоятельно.";
  if (["quantity_pack", "tungsten_qty_pack"].includes(code))
    return "Сколько изделий в одной продаваемой упаковке? Это не остаток на складе.";
  if (
    ["package_net_mass_kg", "filler_rod_package_weight_kg", "saw_wire_package_mass_kg"].includes(
      code,
    )
  )
    return "Масса содержимого одной продаваемой упаковки. Не подставляйте вес вместе с упаковкой.";
  if (["saw_wire_flux_pair", "saw_flux_wire_pairs", "mig_tip_holder_family"].includes(code))
    return "Перенесите точное обозначение и ограничения изготовителя. Похожий размер или название не подтверждают совместимость.";
  if (["brazing_melting_range_c", "electrode_baking", "saw_flux_drying"].includes(code))
    return "Перенесите диапазон и все условия из документа. Не сокращайте до одного числа; при недостатке сведений выберите «Нет подтверждённых сведений».";
  if (code.endsWith("_class") || code === "tungsten_type_iso")
    return "Перенесите маркировку дословно вместе с обозначением стандарта и условиями. Не заменяйте её похожим классом.";
  return "";
}
