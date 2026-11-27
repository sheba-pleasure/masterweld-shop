import type { ReactNode, SVGProps } from "react";

export interface WeldingIconProps extends SVGProps<SVGSVGElement> {
  size?: number;
}

function BaseWeldingIcon({
  size = 18,
  children,
  className,
  ...rest
}: WeldingIconProps & { children: ReactNode }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.65}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** Промышленный сварочный инвертор: корпус, шкала тока, клеммы +/- */
export function ArcInverterIcon(props: WeldingIconProps) {
  return (
    <BaseWeldingIcon {...props}>
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <path d="M8 5V3.5A1.5 1.5 0 0 1 9.5 2h5A1.5 1.5 0 0 1 16 3.5V5" />
      <rect x="6" y="8" width="6.5" height="4" rx="0.8" />
      <circle cx="16.5" cy="10" r="1.8" />
      <circle cx="8" cy="15.5" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="15.5" r="1.1" fill="currentColor" stroke="none" />
      <line x1="15.5" y1="15.5" x2="18.5" y2="15.5" />
    </BaseWeldingIcon>
  );
}

/** Сварочная горелка MIG/MAG: гусак, газовое сопло и искра дуги */
export function MigTorchIcon(props: WeldingIconProps) {
  return (
    <BaseWeldingIcon {...props}>
      <path d="M4 19l5.5-5.5" />
      <path d="M8 15l3.5-3.5a2 2 0 0 1 2.8 0l.7.7" />
      <path d="M13 10l3.5-3.5L19 9l-3.5 3.5" />
      <path d="M18.5 5.5L21 3" />
      <path d="M16 4V2.5M20 8h1.5" />
      <path d="M3 20l2.5-2.5" strokeWidth={2.2} />
    </BaseWeldingIcon>
  );
}

/** Аргонодуговая сварка TIG: вольфрамовый электрод и плазменный факел */
export function TigArcIcon(props: WeldingIconProps) {
  return (
    <BaseWeldingIcon {...props}>
      <path d="M9 3h6l-1.5 7h-3L9 3Z" />
      <path d="M12 10v3.5" />
      <path d="M12 15.5l-4.5 5.5h9L12 15.5Z" strokeDasharray="2 2" />
      <circle cx="12" cy="14.5" r="1.3" fill="currentColor" stroke="none" />
      <line x1="4" y1="21" x2="20" y2="21" />
    </BaseWeldingIcon>
  );
}

/** Плазменная резка CUT: резак, прожиг и разрез листа металла */
export function PlasmaCutIcon(props: WeldingIconProps) {
  return (
    <BaseWeldingIcon {...props}>
      <path d="M9.5 3h5v5l-2.5 3-2.5-3V3Z" />
      <path d="M12 11v10" stroke="var(--mw-cyan)" />
      <path d="M3 16h6.5M14.5 16H21" strokeWidth={2} />
      <path d="M8 19l-2 2M16 19l2 2" />
    </BaseWeldingIcon>
  );
}

/** Газовый редуктор Ar/CO2: два манометра и вентиль */
export function GasRegulatorIcon(props: WeldingIconProps) {
  return (
    <BaseWeldingIcon {...props}>
      <circle cx="8" cy="8" r="3.5" />
      <circle cx="16.5" cy="8" r="3.5" />
      <path d="M8 8l1.6-1.4M16.5 8l-1.3-1.6" />
      <path d="M12 11.5V17" />
      <rect x="8.5" y="14" width="7" height="4" rx="1" />
      <path d="M4 16h4.5M15.5 16H20" />
      <path d="M9.5 21h5" />
      <path d="M12 18v3" />
    </BaseWeldingIcon>
  );
}

/** Маска сварщика «Хамелеон» */
export function WeldingMaskIcon(props: WeldingIconProps) {
  return (
    <BaseWeldingIcon {...props}>
      <path d="M5 9.5C5 5.8 8.1 3 12 3s7 2.8 7 6.5v5.5c0 3.2-3 6-7 6s-7-2.8-7-6V9.5Z" />
      <rect x="7.5" y="8" width="9" height="4.5" rx="1.2" />
      <path d="M9.5 16h5" />
    </BaseWeldingIcon>
  );
}

/** Чертежный прицел / калибровочная метка */
export function CrosshairIcon(props: WeldingIconProps) {
  return (
    <BaseWeldingIcon {...props}>
      <circle cx="12" cy="12" r="6" />
      <line x1="12" y1="2.5" x2="12" y2="7" />
      <line x1="12" y1="17" x2="12" y2="21.5" />
      <line x1="2.5" y1="12" x2="7" y2="12" />
      <line x1="17" y1="12" x2="21.5" y2="12" />
    </BaseWeldingIcon>
  );
}

/** Автоматически подбирает кастомную hardware-иконку по реальному slug/названию категории из БД */
export function CategoryWeldingIcon({
  slug,
  name,
  size = 16,
  className,
}: {
  slug?: string | null | undefined;
  name?: string | null | undefined;
  size?: number | undefined;
  className?: string | undefined;
}) {
  const key = `${slug ?? ""} ${name ?? ""}`.toLowerCase();
  if (/plazm|плазм|cut|резк/.test(key)) {
    return <PlasmaCutIcon size={size} className={className} />;
  }
  if (/tig|аргон/.test(key)) {
    return <TigArcIcon size={size} className={className} />;
  }
  if (/gorel|горел|osnast|оснаст|mig|полуавтомат/.test(key)) {
    return <MigTorchIcon size={size} className={className} />;
  }
  if (/gaz|газ|редуктор|баллон/.test(key)) {
    return <GasRegulatorIcon size={size} className={className} />;
  }
  if (/mask|маск|сиз|защит/.test(key)) {
    return <WeldingMaskIcon size={size} className={className} />;
  }
  return <ArcInverterIcon size={size} className={className} />;
}
