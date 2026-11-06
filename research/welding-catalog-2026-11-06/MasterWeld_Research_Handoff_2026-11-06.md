# «Мастер Сварщик»: исследование каталогов и технический handoff

**Версия:** 1.0 · **Дата:** 06.11.2026 · **Статус:** проектное предложение; не внедрено и не проверено на каждом SKU.

## 0. Цель, методы и границы

Создать не декоративные фильтры, а **модель изделий, сварочных процессов, технических характеристик и совместимости**. Исследованы доступные разделы и карточки специализированных интернет-магазинов (ВсеИнструменты, АССВАР, Сварочник), маркетплейса Ozon, первичные спецификации производителей (Сварог, ESAB, Hypertherm, 3M Speedglas, Binzel, GCE, Miller); сопоставлены с исходным кодом `masterweld.ru` в DevSpace. Дата выборки 06.11.2026; 3M PDF имеет редакцию от 22.06.2022. Полная инвентаризация всех сайтов и всех SKU **не выполнялась**; авторские рекомендации не являются проверенными фактами о каждой модели.

**Метод проверки характеристики:** точная модель/модификация → документ производителя (каталог/паспорт/таблица) → единица измерения, режим, условия испытания → статус `manufacturer_verified` → второе независимое подтверждение при конфликте. Показания маркетплейса только как сигнал, пока нет первичного подтверждения. Пользовательская структура и SEO — отдельно от физической классификации.

**Особый принцип:** Неизвестное поле не равно `false`; отсутствие данных обозначать «Нет подтверждённых сведений», не выводить догадкой.

## 1. Текущее состояние проекта — проверено только чтением

Рабочая папка `/home/codex/projects/masterweld.ru`, исходники React/TypeScript, PostgreSQL/PostgREST. Ключевые места: `drizzle/migrations/0001_catalog.sql` (таблица `products` и категории), `src/lib/search.ts` (клиентский поиск), `src/lib/catalog.ts` (загрузка опубликованных), `src/routes/index.tsx` (каталог), `src/routes/product.$slug.tsx` (карточка), `src/lib/import/catalog-file.ts` (CSV-импорт), `docs/CATALOG-RECONCILIATION.md` (сверка снимка). В `products` характеристики хранятся как текст `specs`; отдельной типизированной структуры нет. Основной поиск: название/бренд/SKU, цена, наличие, акция, категории. Полноценного серверного фасетного индекса нет.

**Снимок старой Cloud от 06.11:** 39 категорий (12 верхних +27 подразделов), 1038 товаров, 1029 опубликовано, у 323 опубликованных нет `specs`, 483 товара без бренда и 76 без артикула. Это **не** живая инвентаризация сегодняшнего production и не доказательство актуальности остатков.

## 2. Архитектура «3 входа в каталог»

1. **Знаю, что ищу:** глобальный поиск по точному SKU (ведущие нули сохранять), артикулу производителя, модели, бренду, русским/латинским синонимам (MIG, MAG, полуавтомат, РДС, MMA, аргонодуговая, TIG, плазморез, CUT), с ранжированием `точный SKU > модель > название > синоним > текст`. Нельзя объединять товары только по совпадению SKU между производителями.
2. **Выбираю процесс:** MMA / MIG-MAG / TIG DC / TIG AC-DC / CUT / газовая / контактная / SAW / трубы / расходники / защита. На верхнем уровне не показывать 100 фильтров; выводить 4–8 главных фасетов по семейству, остальные в «Все параметры».
3. **Решаю задачу:** «Сварить алюминий», «Кузовной ремонт», «Монтаж от сети 220 В», «Работа с нержавейкой», «Резка металла 10–15 мм», «Подобрать к моей горелке». Этот подбор должен быть основан на **проверенных** связях и условиях; при недостатке данных показывать предостережение и запрос нужных данных.

Результат списка: число совпадений, применённые фильтры (чипы), сброс каждого и всех, понятные диапазоны с единицами, сохранение состояния в URL и после возврата из карточки, мобильная панель фильтров, пустые результаты с объяснением. Фасеты пересчитываются **по текущей выборке**, а не просто по всей базе. SEO-страницы — только осмысленные категории; параметрические комбинации не индексировать массово.

## 3. Бенчмарк конкурентов (из доступных публичных страниц)

| Источник | Что видно по доступным материалам | Handoff | Ограничение |
|---|---|---|---|
| [ВсеИнструменты](https://www.vseinstrumenti.ru/category/svarochnye-poluavtomaty-463/) | Много технических фасетов: напряжение, ток, диапазон проволоки, функции, наличие | Основные фильтры группировать по семейству; показывать только применимые | Структура/фильтры по открытой странице; не весь каталог |
| [Ozon](https://www.ozon.ru/category/svarochnoe-oborudovanie-10046/) | Удобные варианты размера/веса/диаметра, поиск по продавцам, отзывы, вопросы | Переключение варианта SKU + отзывы, не импортировать характеристики без проверки | Массовая разметка неоднородна; примеры неоднозначных характеристик |
| [АССВАР](https://assvar.ru/products/category/1927873) | Глубокое дерево категорий и модели семейств горелок | Разделять расходники по семейству/модели/диаметрам | Выборочная проверка дерева каталога |
| [Сварочник](https://svarochnik.ru/svarochnyj-poluavtomat) | Быстрый выбор процесса + функциональные фильтры | Отдельный быстрый вход по MMA/MIG/TIG/CUT | Выборочный просмотр |
| [Сварог](https://svarog-rf.ru/products/real-smart-mig-200/specs) | Подробные режимные спецификации, документация, связанные расходники | Канонический источник по модели, ПН и по режимам | Первичный источник: конкретная модель REAL SMART MIG 200 |
| [Miller](https://www.millerwelds.com/en-us/equipment?CatID=Equipment) | Свойства для задачи: weldable metals, процесс, серии | Поиск по металлу/работе поверх технических фасетов | Доступность отдельных интерактивных элементов не подтверждена |
| [Hypertherm](https://www.hypertherm.com/resources/resources-by-product/?ProductCode=POWERMAX45+SYNC) | Разделение Recommended / Severance / Pierce + скорость реза | Три различных поля реза и материал | Первичный источник конкретной модели |
| [ABICOR BINZEL](https://www.binzel-abicor.com/DE/eng/products/manual/migmag-torches/welding-torch-mb-grip/) | Ток и ПН зависят от CO₂/смеси; серии расходников | Совместимость не по одному слову EURO | Первичный источник горелок |
| [GCE](https://www.gcegroup.com/en/products/basecontrol-flow) | Газ, расход, давление, резьбы, подогреватель | Сертифицированное газовое назначение как обязательный фильтр | Первичный источник конкретной серии |
| [3M Speedglas](https://multimedia.3m.com/mws/media/1798406O/pdf-3m-speedglas-welding-filter-series-g5-01-technical-datasheet.pdf) | Отдельно optical class, light/dark DIN, время при температуре, сенсоры | Полная карточка фильтра плюс параметры совместимых защитных стёкол | Технический документ 3M, Rev 2022-06-22 |

**Важное ограничение:** открытые страницы и спецификации показывают опубликованные поля; пользовательские сценарии покупки, скорость, полнота фильтров при загрузке JS, все вложенные страницы и реальный mobile UX **не были инструментально проверены для каждого сайта**. Поэтому UX-рекомендации — проектная синтезированная оценка, а не результат сплошного A/B-теста.

## 4. Классификация товаров — без смешения сущностей

- Сохранять 12 исходных разделов и slug при миграции. «Акции» — витрина/подборка, но не тип изделия: технические атрибуты привязаны к истинному семейству.
- Один `family_code` задаёт допустимые свойства; многие общие характеристики переиспользуются (бренд, цена, габариты), **специализированные — только к соответствующему оборудованию**.
- Многопроцессный аппарат хранит отдельные свойства для каждого режима, а при развитии — нормализованную таблицу `process_performance` с измерением ПН.
- Комплект/набор — отдельный товар или набор связей: входящие компоненты, количество, условия комплектации. Нельзя смешивать комплектацию аппарата с тем, что есть на складе отдельно.
- Продаваемая модификация — собственный SKU/артикул. Для проволоки ключевые варианты: материал/класс + диаметр + масса + тип катушки; для электрода: класс + диаметр + длина + вес; для наконечника: серия + резьба + под диаметр проволоки + длина. Каждая модификация имеет свою цену/наличие/фото.

### 4.1 Общие для всех семейств поля

| Код | Название | Тип | Ед. | Фильтр | Приоритет |
|---|---|---|---|---|---|
| `brand` | Бренд/производитель | text | — | primary | P0 |
| `manufacturer_article` | Артикул производителя | text | — | none | P0 |
| `supplier_sku` | Артикул поставщика | text | — | none | P0 |
| `model` | Модель/серия | text | — | primary | P0 |
| `country_origin` | Страна происхождения (по документации) | text | — | advanced | P2 |
| `warranty_months` | Гарантия | integer | мес | advanced | P1 |
| `availability` | Наличие | enum | — | primary | P0 |
| `price_rub` | Розничная цена | decimal | RUB | primary | P0 |
| `package_weight_kg` | Вес брутто | decimal | кг | none | P1 |
| `package_length_mm` | Длина упаковки | decimal | мм | none | P1 |
| `package_width_mm` | Ширина упаковки | decimal | мм | none | P1 |
| `package_height_mm` | Высота упаковки | decimal | мм | none | P1 |
| `unit_count` | Количество единиц в упаковке | decimal | шт | advanced | P1 |
| `manual_url` | Инструкция изготовителя | url | — | none | P1 |
| `certificate_url` | Документ о соответствии (если применим) | url | — | none | P2 |

### 4.2 Специальные поля по каждому семейству

В таблицах ниже указано **что указывать**, а не будто такая характеристика уже заполнена у реальных товаров. `primary` — кандидат в основные фильтры, `advanced` — в расширенные, `none` — для карточки/контроля. Метки `P0/P1/P2` — порядок внедрения, а не достоверность значения.

#### 1. Сварочные инверторы MMA — `power_mma`

Корневой раздел: **Сварочные аппараты**; процесс: MMA / РДС.

| Поле (`key`) | Характеристика | Тип / единица | Фильтр | Этап |
|---|---|---|---|---|
| `mains_phases` | Число фаз | enum | primary | P0 |
| `mains_nominal_v` | Номинальное напряжение сети | number / В | primary | P0 |
| `mains_work_min_v` | Нижняя граница рабочего напряжения | number / В | advanced | P0 |
| `mains_work_max_v` | Верхняя граница рабочего напряжения | number / В | advanced | P0 |
| `mma_current_min_a` | Минимальный ток MMA | number / А | advanced | P0 |
| `mma_current_max_a` | Максимальный ток MMA | number / А | primary | P0 |
| `mma_electrode_diameters_mm` | Диаметры MMA-электродов | number_list / мм | primary | P0 |
| `mma_duty_cycle_pct` | ПН MMA (при указанном токе) | number / % | advanced | P0 |
| `mma_duty_current_a` | Ток при указанной ПН MMA | number / А | advanced | P0 |
| `mma_duty_temp_c` | Температура испытания ПН MMA | number / °C | none | P0 |
| `mma_continuous_current_a` | Ток MMA при ПН 100% | number / А | advanced | P0 |
| `hot_start` | Hot Start | boolean | advanced | P0 |
| `arc_force` | Arc Force | boolean | advanced | P0 |
| `anti_stick` | Anti Stick | boolean | advanced | P0 |
| `vrd` | VRD | boolean | advanced | P0 |
| `output_connector` | Силовой разъём | enum | advanced | P1 |
| `source_net_weight_kg` | Вес источника без упаковки | number / кг | advanced | P1 |

#### 2. Полуавтоматы MIG/MAG и FCAW — `power_mig`

Корневой раздел: **Сварочные аппараты**; процесс: MIG/MAG / FCAW.

| Поле (`key`) | Характеристика | Тип / единица | Фильтр | Этап |
|---|---|---|---|---|
| `mains_phases` | Число фаз | enum | primary | P0 |
| `mains_nominal_v` | Номинальная сеть | number / В | primary | P0 |
| `mains_work_min_v` | Минимальное рабочее напряжение сети | number / В | advanced | P1 |
| `mig_current_min_a` | Ток MIG/MAG минимум | number / А | advanced | P0 |
| `mig_current_max_a` | Ток MIG/MAG максимум | number / А | primary | P0 |
| `mig_duty_cycle_pct` | ПН MIG (условия указаны отдельно) | number / % | advanced | P0 |
| `mig_duty_current_a` | Ток MIG при ПН | number / А | advanced | P0 |
| `mig_continuous_current_a` | Ток MIG при ПН 100% | number / А | advanced | P0 |
| `mig_duty_temp_c` | Температура ПН | number / °C | none | P0 |
| `mig_wire_diameters_mm` | Поддерживаемые диаметры проволоки MIG | number_list / мм | primary | P0 |
| `mig_solid_wire` | Работа со сплошной проволокой | boolean | advanced | P0 |
| `mig_selfshield_flux` | Работа с самозащитной порошковой проволокой | boolean | primary | P0 |
| `mig_gas_shielded_flux` | Работа с газозащитной порошковой проволокой | boolean | advanced | P1 |
| `mig_aluminum` | Возможность MIG сварки алюминия | boolean | primary | P0 |
| `mig_pulse` | Импульс MIG/MAG | boolean | advanced | P1 |
| `mig_double_pulse` | Двойной импульс MIG/MAG | boolean | advanced | P1 |
| `mig_synergy` | Синергетические программы | boolean | primary | P0 |
| `feed_rollers_count` | Число роликов подачи | integer / шт | advanced | P1 |
| `spool_mass_max_kg` | Максимальная масса катушки | number / кг | primary | P0 |
| `spool_formats` | Форматы катушек | enum_list | advanced | P1 |
| `mig_torch_connector` | Разъём горелки | enum | primary | P0 |
| `polarity_change` | Переключение полярности | boolean | primary | P0 |
| `welding_processes` | Режимы MMA/MIG/TIG/CUT | enum_list | primary | P0 |
| `wire_feed_speed_min_m_min` | Минимальная подача проволоки | number / м/мин | advanced | P1 |
| `wire_feed_speed_max_m_min` | Максимальная подача проволоки | number / м/мин | advanced | P1 |

#### 3. Аргонодуговые аппараты TIG DC — `power_tig_dc`

Корневой раздел: **Сварочные аппараты**; процесс: TIG DC.

| Поле (`key`) | Характеристика | Тип / единица | Фильтр | Этап |
|---|---|---|---|---|
| `tig_polarity_modes` | Род тока TIG | enum_list | primary | P0 |
| `tig_current_min_a` | Ток TIG минимум | number / А | advanced | P0 |
| `tig_current_max_a` | Ток TIG максимум | number / А | primary | P0 |
| `tig_start_modes` | Поджиг дуги HF/Lift/касанием | enum_list | primary | P0 |
| `tig_pulse` | Импульсный режим TIG | boolean | advanced | P0 |
| `tig_2t_4t` | Режимы 2T/4T | enum_list | advanced | P1 |
| `tig_gas_preflow_s` | Продувка газа до сварки | number / с | advanced | P1 |
| `tig_gas_postflow_s` | Продувка газа после сварки | number / с | advanced | P1 |
| `tig_downslope_s` | Спад тока | number / с | advanced | P1 |
| `tig_remote_pedal` | Подключение педали/ДУ | boolean | advanced | P1 |
| `tig_duty_cycle_pct` | ПН TIG | number / % | advanced | P0 |
| `tig_duty_current_a` | Ток TIG при ПН | number / А | advanced | P0 |
| `tig_duty_temp_c` | Температура ПН | number / °C | none | P0 |
| `tig_torch_connector` | Разъём TIG-горелки | enum | advanced | P1 |
| `mains_nominal_v` | Номинальная сеть | number / В | primary | P0 |

#### 4. Аргонодуговые аппараты TIG AC/DC — `power_tig_acdc`

Корневой раздел: **Сварочные аппараты**; процесс: TIG AC/DC.

| Поле (`key`) | Характеристика | Тип / единица | Фильтр | Этап |
|---|---|---|---|---|
| `tig_polarity_modes` | Род тока TIG (AC/DC) | enum_list | primary | P0 |
| `tig_current_min_a` | Ток TIG минимум | number / А | advanced | P0 |
| `tig_current_max_a` | Ток TIG максимум | number / А | primary | P0 |
| `tig_ac_frequency_min_hz` | Частота AC TIG минимум | number / Гц | advanced | P1 |
| `tig_ac_frequency_max_hz` | Частота AC TIG максимум | number / Гц | advanced | P1 |
| `tig_ac_balance_adjustable` | Регулировка баланса AC | boolean | advanced | P1 |
| `tig_start_modes` | Поджиг HF/Lift | enum_list | primary | P0 |
| `tig_pulse` | Импульсный TIG | boolean | primary | P0 |
| `tig_pulse_freq_max_hz` | Максимальная частота импульсов | number / Гц | advanced | P1 |
| `tig_2t_4t` | Режимы 2T/4T | enum_list | advanced | P1 |
| `tig_remote_pedal` | Подключение педали | boolean | advanced | P1 |
| `tig_water_cooler_support` | Подключение охлаждения | boolean | advanced | P1 |
| `tig_duty_cycle_pct` | ПН TIG | number / % | advanced | P0 |
| `tig_duty_current_a` | Ток при ПН TIG | number / А | advanced | P0 |
| `tig_duty_temp_c` | Температура ПН | number / °C | none | P0 |
| `mains_phases` | Число фаз | enum | primary | P0 |

#### 5. Многопроцессные аппараты MMA/MIG/TIG — `power_multiprocess`

Корневой раздел: **Сварочные аппараты**; процесс: MMA / MIG / TIG.

| Поле (`key`) | Характеристика | Тип / единица | Фильтр | Этап |
|---|---|---|---|---|
| `welding_processes` | Фактические режимы сварки | enum_list | primary | P0 |
| `mma_current_min_a` | Ток MMA минимум | number / А | advanced | P0 |
| `mma_current_max_a` | Ток MMA максимум | number / А | primary | P0 |
| `mig_current_min_a` | Ток MIG минимум | number / А | advanced | P0 |
| `mig_current_max_a` | Ток MIG максимум | number / А | primary | P0 |
| `tig_current_min_a` | Ток TIG минимум | number / А | advanced | P0 |
| `tig_current_max_a` | Ток TIG максимум | number / А | primary | P0 |
| `tig_polarity_modes` | Род тока TIG | enum_list | primary | P0 |
| `tig_start_modes` | Поджиг TIG | enum_list | advanced | P0 |
| `mig_wire_diameters_mm` | Диаметры MIG-проволоки | number_list / мм | primary | P0 |
| `mig_duty_cycle_pct` | ПН MIG | number / % | advanced | P0 |
| `mma_duty_cycle_pct` | ПН MMA | number / % | advanced | P0 |
| `tig_duty_cycle_pct` | ПН TIG | number / % | advanced | P0 |
| `duty_test_temp_c` | Температура испытания | number / °C | none | P0 |
| `power_consumption_by_mode_kva` | Полная мощность отдельно по режимам | mode_map / кВА | none | P1 |
| `mains_nominal_v` | Напряжение сети | number / В | primary | P0 |

#### 6. Аппараты воздушно-плазменной резки CUT — `power_cut`

Корневой раздел: **Плазменная резка**; процесс: CUT.

| Поле (`key`) | Характеристика | Тип / единица | Фильтр | Этап |
|---|---|---|---|---|
| `mains_nominal_v` | Номинальная сеть | number / В | primary | P0 |
| `cut_current_min_a` | Ток CUT минимум | number / А | advanced | P0 |
| `cut_current_max_a` | Ток CUT максимум | number / А | primary | P0 |
| `cut_recommended_thickness_mm` | Рекомендуемая толщина реза | number / мм | primary | P0 |
| `cut_severance_thickness_mm` | Предельный разделительный рез | number / мм | advanced | P0 |
| `cut_piercing_thickness_mm` | Толщина прожига | number / мм | advanced | P1 |
| `cut_material` | Металл, к которому относится толщина | enum | advanced | P0 |
| `cut_speed_at_thickness_mm_min` | Скорость реза при указанной толщине | number / мм/мин | advanced | P1 |
| `cut_max_thickness_marketing_mm` | Неуточнённая максимальная толщина (не для фасета) | number / мм | none | P0 |
| `compressed_air_flow_l_min` | Требуемый расход воздуха | number / л/мин | primary | P0 |
| `compressed_air_pressure_bar` | Требуемое давление воздуха | number / бар | primary | P0 |
| `integrated_compressor` | Встроенный компрессор | boolean | primary | P1 |
| `pilot_arc` | Пилотная дуга | boolean | advanced | P1 |
| `cut_torch_series` | Серия плазмотрона | enum | advanced | P0 |
| `cut_duty_cycle_pct` | ПН CUT | number / % | advanced | P0 |
| `cut_duty_current_a` | Ток при ПН CUT | number / А | advanced | P0 |
| `cut_duty_temp_c` | Температура ПН | number / °C | none | P0 |

#### 7. Источники сварки под флюсом SAW — `power_saw`

Корневой раздел: **Сварка под флюсом**; процесс: SAW.

| Поле (`key`) | Характеристика | Тип / единица | Фильтр | Этап |
|---|---|---|---|---|
| `saw_current_min_a` | Ток SAW минимум | number / А | advanced | P0 |
| `saw_current_max_a` | Ток SAW максимум | number / А | primary | P0 |
| `saw_polarity_modes` | Род тока AC/DC | enum_list | primary | P0 |
| `saw_duty_cycle_pct` | ПН при токе SAW | number / % | advanced | P0 |
| `saw_wire_diameters_mm` | Диаметры SAW-проволоки | number_list / мм | primary | P0 |
| `saw_feed_speed_m_min` | Скорость подачи | number / м/мин | advanced | P1 |
| `saw_travel_speed_mm_min` | Скорость перемещения | number / мм/мин | advanced | P1 |
| `saw_control_compatibility` | Совместимые головки/тракторы | text | advanced | P0 |
| `mains_nominal_v` | Питающая сеть | number / В | primary | P0 |

#### 8. Контактная точечная и шовная сварка — `power_spot`

Корневой раздел: **Контактная сварка**; процесс: RSW.

| Поле (`key`) | Характеристика | Тип / единица | Фильтр | Этап |
|---|---|---|---|---|
| `spot_method` | Тип (точечная/шовная/стыковая) | enum | primary | P0 |
| `spot_rated_power_kva` | Номинальная полная мощность | number / кВА | advanced | P0 |
| `spot_max_power_kva` | Максимальная полная мощность | number / кВА | advanced | P1 |
| `spot_weld_thickness_pair_mm` | Толщина каждого из двух листов (условия) | text / мм | primary | P0 |
| `spot_electrode_force_n` | Усилие электродов | number / Н | advanced | P1 |
| `spot_electrode_stroke_mm` | Ход электродов | number / мм | advanced | P1 |
| `spot_throat_depth_mm` | Вылет электродов | number / мм | advanced | P1 |
| `spot_water_cooling` | Водяное охлаждение | boolean | advanced | P1 |
| `mains_phases` | Число фаз | enum | primary | P0 |

#### 9. Аппараты приварки шпилек — `power_stud`

Корневой раздел: **Сварочные аппараты**; процесс: Stud welding.

| Поле (`key`) | Характеристика | Тип / единица | Фильтр | Этап |
|---|---|---|---|---|
| `stud_method` | Процесс (дуговая/конденсаторная) | enum | primary | P0 |
| `stud_diameter_min_mm` | Минимальный диаметр шпильки | number / мм | primary | P0 |
| `stud_diameter_max_mm` | Максимальный диаметр шпильки | number / мм | primary | P0 |
| `stud_materials` | Материалы шпилек | enum_list | advanced | P1 |
| `stud_weld_time_ms` | Продолжительность импульса | number / мс | advanced | P1 |
| `stud_energy_j` | Энергия импульса | number / Дж | advanced | P1 |
| `mains_nominal_v` | Питающая сеть | number / В | primary | P0 |

#### 10. Лазерная ручная сварка — `power_laser`

Корневой раздел: **Сварочные аппараты**; процесс: Laser.

| Поле (`key`) | Характеристика | Тип / единица | Фильтр | Этап |
|---|---|---|---|---|
| `laser_source_power_w` | Мощность лазера | number / Вт | primary | P0 |
| `laser_wavelength_nm` | Длина волны | number / нм | advanced | P0 |
| `laser_process_modes` | Сварка/очистка/резка | enum_list | advanced | P0 |
| `laser_cooling` | Охлаждение | enum | advanced | P0 |
| `laser_fiber_length_m` | Длина оптоволокна | number / м | advanced | P1 |
| `laser_materials` | Рекомендованные материалы | enum_list | advanced | P1 |
| `laser_max_thickness_by_material` | Толщина по материалу и условиям | text | none | P1 |
| `laser_safety_class` | Класс лазерной опасности по документации | text | advanced | P0 |
| `mains_nominal_v` | Питающая сеть | number / В | primary | P0 |

#### 11. Паяльники для раструбной сварки пластиковых труб — `pipe_socket`

Корневой раздел: **Сварка пластиковых труб**; процесс: Polyfusion.

| Поле (`key`) | Характеристика | Тип / единица | Фильтр | Этап |
|---|---|---|---|---|
| `pipe_materials` | Материал труб (PP-R и др.) | enum_list | primary | P0 |
| `pipe_socket_diameters_mm` | Диаметры насадок | number_list / мм | primary | P0 |
| `pipe_heater_power_w` | Мощность нагревателя | number / Вт | advanced | P0 |
| `pipe_temperature_control` | Терморегулятор | boolean | advanced | P0 |
| `pipe_temperature_range_c` | Диапазон температуры нагрева | text / °C | advanced | P1 |
| `pipe_nozzles_included` | Насадки в комплекте | number_list / мм | advanced | P0 |

#### 12. Аппараты электромуфтовой сварки — `pipe_electrofusion`

Корневой раздел: **Сварка пластиковых труб**; процесс: Electrofusion.

| Поле (`key`) | Характеристика | Тип / единица | Фильтр | Этап |
|---|---|---|---|---|
| `electrofusion_pipe_material` | Материал труб (PE и др.) | enum | primary | P0 |
| `electrofusion_voltage_range_v` | Выходное напряжение сварки | text / В | advanced | P0 |
| `electrofusion_fitting_diameters_mm` | Диаметры фитингов | text / мм | primary | P0 |
| `electrofusion_barcode` | Сканер штрихкодов | boolean | advanced | P1 |
| `electrofusion_trace_logging` | Протоколирование швов | boolean | advanced | P1 |
| `electrofusion_connector_type` | Разъём фитинга | enum | advanced | P0 |
| `mains_nominal_v` | Питающая сеть | number / В | primary | P0 |

#### 13. Сварочные электрогенераторы — `weld_generator`

Корневой раздел: **Генераторы и компрессоры**; процесс: Generator welding.

| Поле (`key`) | Характеристика | Тип / единица | Фильтр | Этап |
|---|---|---|---|---|
| `generator_fuel` | Топливо | enum | primary | P0 |
| `generator_rated_power_kw` | Номинальная активная мощность | number / кВт | advanced | P0 |
| `generator_rated_power_kva` | Номинальная полная мощность | number / кВА | advanced | P0 |
| `generator_voltage_v` | Выходное напряжение | number / В | primary | P0 |
| `generator_phase` | Число фаз | enum | primary | P0 |
| `generator_inverter_compatible` | Совместимость с инверторами, подтверждённая производителем | boolean | advanced | P1 |
| `mma_current_max_a` | Ток MMA встроенного поста (если есть) | number / А | advanced | P0 |
| `generator_run_time_h` | Автономность при нагрузке | number / ч | advanced | P1 |
| `generator_fuel_tank_l` | Бак | number / л | advanced | P1 |

#### 14. Покрытые электроды MMA — `consumable_mma_electrodes`

Корневой раздел: **Расходники для электросварки**; процесс: SMAW consumable.

| Поле (`key`) | Характеристика | Тип / единица | Фильтр | Этап |
|---|---|---|---|---|
| `electrode_standard_class` | Классификация AWS/ISO/ГОСТ (дословно) | text | primary | P0 |
| `electrode_coating` | Тип покрытия (рутиловое/основное/целлюлозное) | enum | primary | P0 |
| `electrode_diameter_mm` | Диаметр электрода | number / мм | primary | P0 |
| `electrode_length_mm` | Длина электрода | number / мм | advanced | P1 |
| `electrode_welding_positions` | Пространственные положения | enum_list | advanced | P1 |
| `electrode_polarity` | Полярность и AC/DC | enum_list | primary | P0 |
| `electrode_current_min_a` | Ток, нижняя граница для этого диаметра | number / А | advanced | P0 |
| `electrode_current_max_a` | Ток, верхняя граница для этого диаметра | number / А | advanced | P0 |
| `electrode_deposited_metal` | Класс наплавленного металла | text | advanced | P1 |
| `package_net_mass_kg` | Масса электродов в упаковке | number / кг | primary | P0 |
| `electrode_baking` | Требования к прокалке по изготовителю | text | none | P1 |

#### 15. Сплошная проволока MIG/MAG — `consumable_mig_wire_solid`

Корневой раздел: **Расходники для электросварки**; процесс: GMAW wire.

| Поле (`key`) | Характеристика | Тип / единица | Фильтр | Этап |
|---|---|---|---|---|
| `wire_standard_class` | Класс проволоки AWS/ISO/ГОСТ | text | primary | P0 |
| `wire_material` | Материал/назначение (сталь, нержавейка, алюминий) | enum | primary | P0 |
| `wire_diameter_mm` | Диаметр проволоки | number / мм | primary | P0 |
| `wire_coating` | Омеднение/без покрытия | enum | advanced | P0 |
| `wire_gas_groups` | Защитный газ/смесь по данным изготовителя | enum_list | advanced | P0 |
| `wire_spool_type` | Формат катушки (D100/D200/D300 и т.п.) | enum | primary | P0 |
| `wire_spool_net_mass_kg` | Масса проволоки на катушке | number / кг | primary | P0 |
| `wire_polarity` | Полярность | enum | advanced | P1 |
| `wire_welding_positions` | Положения сварки | enum_list | advanced | P2 |
| `wire_standard_notes` | Ограничения классификации | text | none | P1 |

#### 16. Порошковая сварочная проволока FCAW — `consumable_flux_wire`

Корневой раздел: **Расходники для электросварки**; процесс: FCAW wire.

| Поле (`key`) | Характеристика | Тип / единица | Фильтр | Этап |
|---|---|---|---|---|
| `wire_standard_class` | Марка/классификация | text | primary | P0 |
| `wire_diameter_mm` | Диаметр | number / мм | primary | P0 |
| `flux_wire_gas_mode` | Самозащитная или под газом | enum | primary | P0 |
| `wire_polarity` | Необходимая полярность | enum | primary | P0 |
| `wire_welding_positions` | Пространственные положения | enum_list | advanced | P1 |
| `wire_spool_type` | Тип катушки | enum | advanced | P0 |
| `wire_spool_net_mass_kg` | Масса проволоки | number / кг | primary | P0 |
| `wire_base_metals` | Материал сварки | enum_list | advanced | P1 |

#### 17. Присадочные прутки TIG — `consumable_tig_rod`

Корневой раздел: **Расходники для электросварки**; процесс: GTAW filler.

| Поле (`key`) | Характеристика | Тип / единица | Фильтр | Этап |
|---|---|---|---|---|
| `filler_rod_class` | Марка/классификация AWS/ISO | text | primary | P0 |
| `filler_rod_alloy` | Сплав/назначение | enum | primary | P0 |
| `filler_rod_diameter_mm` | Диаметр прутка | number / мм | primary | P0 |
| `filler_rod_length_mm` | Длина прутка | number / мм | advanced | P0 |
| `filler_rod_package_weight_kg` | Масса упаковки | number / кг | primary | P0 |
| `filler_rod_gas` | Рекомендованный газ | enum_list | advanced | P2 |

#### 18. Проволока SAW — `consumable_saw_wire`

Корневой раздел: **Сварка под флюсом**; процесс: SAW wire.

| Поле (`key`) | Характеристика | Тип / единица | Фильтр | Этап |
|---|---|---|---|---|
| `saw_wire_class` | Марка проволоки/класс | text | primary | P0 |
| `saw_wire_diameter_mm` | Диаметр проволоки | number / мм | primary | P0 |
| `saw_wire_package_mass_kg` | Вес бухты/кассеты | number / кг | primary | P0 |
| `saw_wire_flux_pair` | Совместимые флюсы по рекомендациям | text | advanced | P1 |
| `saw_wire_base_metal` | Материал сварки | enum_list | advanced | P1 |

#### 19. Флюс для сварки SAW — `consumable_saw_flux`

Корневой раздел: **Сварка под флюсом**; процесс: SAW flux.

| Поле (`key`) | Характеристика | Тип / единица | Фильтр | Этап |
|---|---|---|---|---|
| `saw_flux_class` | Классификация флюса | text | primary | P0 |
| `saw_flux_type` | Агломерированный/плавленый | enum | primary | P0 |
| `saw_flux_grain_min_mm` | Размер зерна минимум | number / мм | advanced | P0 |
| `saw_flux_grain_max_mm` | Размер зерна максимум | number / мм | advanced | P0 |
| `saw_flux_wire_pairs` | Рекомендованные пары с проволокой | text | advanced | P0 |
| `saw_flux_drying` | Правила хранения/сушки | text | none | P1 |
| `package_net_mass_kg` | Масса упаковки | number / кг | primary | P0 |

#### 20. Вольфрамовые неплавящиеся электроды TIG — `consumable_tungsten`

Корневой раздел: **Расходники для электросварки**; процесс: TIG tungsten.

| Поле (`key`) | Характеристика | Тип / единица | Фильтр | Этап |
|---|---|---|---|---|
| `tungsten_type_iso` | Маркировка ISO/изготовителя | text | primary | P0 |
| `tungsten_additive` | Легирование (лантан, церий и др.) | enum | primary | P0 |
| `tungsten_diameter_mm` | Диаметр | number / мм | primary | P0 |
| `tungsten_length_mm` | Длина | number / мм | advanced | P0 |
| `tungsten_ac_dc_usage` | Применение AC/DC по изготовителю | enum_list | advanced | P0 |
| `tungsten_tip_color` | Цвет маркировки (если стандартизован) | enum | advanced | P1 |
| `tungsten_qty_pack` | Штук в упаковке | integer / шт | advanced | P1 |

#### 21. Сварочные горелки MIG/MAG — `mig_torch`

Корневой раздел: **Оборудование и аксессуары**; процесс: MIG torch.

| Поле (`key`) | Характеристика | Тип / единица | Фильтр | Этап |
|---|---|---|---|---|
| `mig_torch_series` | Серия (MB15/24/36 и т. п.) | enum | primary | P0 |
| `mig_torch_length_m` | Длина рукава | number / м | primary | P0 |
| `mig_torch_cooling` | Воздушное/жидкостное охлаждение | enum | primary | P0 |
| `mig_torch_connector` | Разъём (EURO и прочее) | enum | primary | P0 |
| `mig_torch_amp_co2_a` | Номинальный ток в CO₂ | number / А | advanced | P0 |
| `mig_torch_amp_m21_a` | Номинальный ток в смеси M21 | number / А | advanced | P0 |
| `mig_torch_duty_pct` | ПН горелки | number / % | advanced | P0 |
| `mig_torch_wire_diameters_mm` | Поддерживаемые диаметры проволоки | number_list / мм | primary | P0 |
| `mig_torch_replacement_family` | Совместимые семейства расходников | text | advanced | P0 |

#### 22. Сварочные горелки TIG — `tig_torch`

Корневой раздел: **Оборудование и аксессуары**; процесс: TIG torch.

| Поле (`key`) | Характеристика | Тип / единица | Фильтр | Этап |
|---|---|---|---|---|
| `tig_torch_series` | Серия (9/17/18/26 и пр.) | enum | primary | P0 |
| `tig_torch_length_m` | Длина | number / м | primary | P0 |
| `tig_torch_cooling` | Воздушное/жидкостное охлаждение | enum | primary | P0 |
| `tig_torch_max_dc_a` | Ток DC при заявленной ПН | number / А | advanced | P0 |
| `tig_torch_max_ac_a` | Ток AC при заявленной ПН | number / А | advanced | P0 |
| `tig_torch_duty_pct` | ПН горелки | number / % | advanced | P0 |
| `tig_torch_power_connector` | Силовой разъём | enum | advanced | P0 |
| `tig_torch_gas_connector` | Газовый разъём | enum | advanced | P0 |
| `tig_torch_control_connector` | Разъём кнопки управления | enum | advanced | P0 |
| `tig_torch_tungsten_diameters_mm` | Диаметры вольфрама | number_list / мм | primary | P0 |

#### 23. Плазмотроны CUT — `cut_torch`

Корневой раздел: **Плазменная резка**; процесс: Plasma torch.

| Поле (`key`) | Характеристика | Тип / единица | Фильтр | Этап |
|---|---|---|---|---|
| `cut_torch_series` | Серия (PT31/P80/и др.) | enum | primary | P0 |
| `cut_torch_current_max_a` | Допустимый ток горелки | number / А | primary | P0 |
| `cut_torch_length_m` | Длина рукава | number / м | primary | P0 |
| `cut_torch_ignition` | Тип поджига | enum | advanced | P0 |
| `cut_torch_connector` | Тип соединения | enum | primary | P0 |
| `cut_torch_cooling` | Тип охлаждения | enum | advanced | P1 |
| `cut_torch_consumable_family` | Семейство расходников | enum | primary | P0 |
| `cut_torch_air_flow_l_min` | Потребность в воздухе | number / л/мин | advanced | P1 |

#### 24. Контактные наконечники MIG/MAG — `mig_contact_tip`

Корневой раздел: **Оборудование и аксессуары**; процесс: MIG tip.

| Поле (`key`) | Характеристика | Тип / единица | Фильтр | Этап |
|---|---|---|---|---|
| `mig_tip_wire_diameter_mm` | Диаметр проволоки | number / мм | primary | P0 |
| `mig_tip_thread` | Резьба наконечника (М6/М8/иное) | enum | primary | P0 |
| `mig_tip_length_mm` | Длина наконечника | number / мм | primary | P0 |
| `mig_tip_material` | Материал наконечника | enum | advanced | P1 |
| `mig_tip_torch_family` | Серия совместимых горелок | enum_list | primary | P0 |
| `mig_tip_holder_family` | Совместимый держатель | text | advanced | P0 |
| `quantity_pack` | Штук в упаковке | integer / шт | advanced | P1 |

#### 25. Газовые сопла MIG/MAG — `mig_gas_nozzle`

Корневой раздел: **Оборудование и аксессуары**; процесс: MIG nozzle.

| Поле (`key`) | Характеристика | Тип / единица | Фильтр | Этап |
|---|---|---|---|---|
| `mig_nozzle_torch_family` | Серия горелки | enum_list | primary | P0 |
| `mig_nozzle_shape` | Форма сопла | enum | advanced | P1 |
| `mig_nozzle_inner_diameter_mm` | Диаметр выходного отверстия | number / мм | primary | P0 |
| `mig_nozzle_length_mm` | Длина сопла | number / мм | advanced | P1 |
| `mig_nozzle_attachment` | Способ крепления | enum | advanced | P0 |
| `quantity_pack` | Штук в упаковке | integer / шт | advanced | P1 |

#### 26. Каналы/направляющие проволоки MIG — `mig_liner`

Корневой раздел: **Оборудование и аксессуары**; процесс: MIG liner.

| Поле (`key`) | Характеристика | Тип / единица | Фильтр | Этап |
|---|---|---|---|---|
| `mig_liner_wire_diameter_min_mm` | Минимальный диаметр проволоки | number / мм | primary | P0 |
| `mig_liner_wire_diameter_max_mm` | Максимальный диаметр проволоки | number / мм | primary | P0 |
| `mig_liner_length_m` | Длина канала | number / м | primary | P0 |
| `mig_liner_material` | Материал (сталь/PTFE и др.) | enum | primary | P0 |
| `mig_liner_torch_family` | Серия горелки | enum_list | primary | P0 |
| `mig_liner_end_fitting` | Тип окончания/фиксатора | enum | advanced | P0 |

#### 27. Ролики подачи сварочной проволоки — `feed_rollers`

Корневой раздел: **Оборудование и аксессуары**; процесс: Feeder roll.

| Поле (`key`) | Характеристика | Тип / единица | Фильтр | Этап |
|---|---|---|---|---|
| `roller_wire_diameters_mm` | Диаметры проволоки | number_list / мм | primary | P0 |
| `roller_groove` | Профиль канавки V/U/насечка | enum | primary | P0 |
| `roller_outer_diameter_mm` | Внешний диаметр ролика | number / мм | advanced | P0 |
| `roller_inner_diameter_mm` | Посадочный диаметр | number / мм | advanced | P0 |
| `roller_width_mm` | Ширина ролика | number / мм | advanced | P0 |
| `roller_feeder_models` | Совместимые подачи/аппараты | enum_list | primary | P0 |

#### 28. Цанги, линзы, керамические сопла TIG — `tig_kit_parts`

Корневой раздел: **Оборудование и аксессуары**; процесс: TIG parts.

| Поле (`key`) | Характеристика | Тип / единица | Фильтр | Этап |
|---|---|---|---|---|
| `tig_part_type` | Тип (цанга/корпус/линза/сопло) | enum | primary | P0 |
| `tig_torch_series` | Серия TIG-горелки | enum | primary | P0 |
| `tig_tungsten_diameter_mm` | Под какой диаметр вольфрама | number / мм | primary | P0 |
| `tig_cup_size` | Размер керамического сопла № | integer / № | advanced | P0 |
| `tig_gas_lens` | Газовая линза | boolean | advanced | P1 |
| `tig_part_length_mm` | Длина | number / мм | advanced | P1 |
| `quantity_pack` | Количество | integer / шт | advanced | P1 |

#### 29. Сопла, электроды, защитные колпачки CUT — `cut_parts`

Корневой раздел: **Плазменная резка**; процесс: CUT consumables.

| Поле (`key`) | Характеристика | Тип / единица | Фильтр | Этап |
|---|---|---|---|---|
| `cut_part_type` | Тип (сопло/электрод/завихритель/щиток) | enum | primary | P0 |
| `cut_torch_series` | Серия плазмотрона | enum | primary | P0 |
| `cut_part_nominal_current_a` | Ток/номинал сопла (если применим) | number / А | primary | P0 |
| `cut_nozzle_orifice_mm` | Диаметр отверстия сопла | number / мм | advanced | P0 |
| `cut_part_process` | Ручная/механизированная резка | enum | advanced | P1 |
| `cut_part_manufacturer_code` | Код производителя для совместимости | text | primary | P0 |
| `quantity_pack` | Количество | integer / шт | advanced | P1 |

#### 30. Электрододержатели MMA — `mma_holder`

Корневой раздел: **Оборудование и аксессуары**; процесс: MMA holder.

| Поле (`key`) | Характеристика | Тип / единица | Фильтр | Этап |
|---|---|---|---|---|
| `holder_nominal_current_a` | Номинальный ток | number / А | primary | P0 |
| `holder_electrode_diameter_min_mm` | Диаметр электрода минимум | number / мм | advanced | P0 |
| `holder_electrode_diameter_max_mm` | Диаметр электрода максимум | number / мм | advanced | P0 |
| `holder_cable_connection` | Присоединение сварочного кабеля | enum | advanced | P0 |
| `holder_model` | Конструкция/тип | enum | advanced | P1 |

#### 31. Зажимы массы сварочные — `ground_clamp`

Корневой раздел: **Оборудование и аксессуары**; процесс: Ground clamp.

| Поле (`key`) | Характеристика | Тип / единица | Фильтр | Этап |
|---|---|---|---|---|
| `clamp_nominal_current_a` | Номинальный ток | number / А | primary | P0 |
| `clamp_jaw_opening_mm` | Раскрытие губок | number / мм | advanced | P1 |
| `clamp_cable_connection` | Подключение кабеля | enum | advanced | P0 |
| `clamp_material` | Материал контактов | enum | advanced | P1 |

#### 32. Сварочные кабели и соединения — `welding_cable`

Корневой раздел: **Оборудование и аксессуары**; процесс: Welding cable.

| Поле (`key`) | Характеристика | Тип / единица | Фильтр | Этап |
|---|---|---|---|---|
| `cable_conductor_cross_section_mm2` | Сечение токопроводящей жилы | number / мм² | primary | P0 |
| `cable_conductor_material` | Материал жилы | enum | primary | P0 |
| `cable_length_m` | Длина | number / м | primary | P0 |
| `cable_insulation_type` | Тип изоляции/марка | text | advanced | P0 |
| `cable_connector_type` | Разъём/оконцевание | enum | advanced | P0 |
| `cable_current_limit_a` | Допустимый ток при указанных условиях | number / А | advanced | P1 |

#### 33. Маски сварщика с автозатемнением — `mask_adf`

Корневой раздел: **Защита сварщика**; процесс: ADF mask.

| Поле (`key`) | Характеристика | Тип / единица | Фильтр | Этап |
|---|---|---|---|---|
| `mask_optical_class` | Оптический класс (четыре цифры) | text | primary | P0 |
| `mask_light_shade_din` | Светлое состояние DIN | number / DIN | advanced | P0 |
| `mask_dark_shade_min_din` | Нижний предел затемнения DIN | number / DIN | primary | P0 |
| `mask_dark_shade_max_din` | Верхний предел затемнения DIN | number / DIN | primary | P0 |
| `mask_view_width_mm` | Ширина зоны обзора | number / мм | advanced | P0 |
| `mask_view_height_mm` | Высота зоны обзора | number / мм | advanced | P0 |
| `mask_sensors` | Количество датчиков | integer / шт | advanced | P0 |
| `mask_switching_time_ms` | Время затемнения при заданной t | number / мс | advanced | P0 |
| `mask_switching_temp_c` | Температура замера времени затемнения | number / °C | none | P0 |
| `mask_grinding_mode` | Режим шлифовки | boolean | primary | P0 |
| `mask_cut_mode` | Режим резки | boolean | advanced | P1 |
| `mask_tig_lowamp` | Заявленная пригодность для TIG на малых токах | boolean | advanced | P1 |
| `mask_power_type` | Солнечный элемент/батарея | enum_list | advanced | P1 |
| `mask_filter_replaceable` | Сменный фильтр | boolean | advanced | P1 |
| `mask_papr_compatibility` | Совместимость с блоком подачи воздуха | enum_list | advanced | P2 |

#### 34. Маски и щитки с постоянным фильтром — `mask_passive`

Корневой раздел: **Защита сварщика**; процесс: Passive mask.

| Поле (`key`) | Характеристика | Тип / единица | Фильтр | Этап |
|---|---|---|---|---|
| `mask_fixed_shade_din` | Постоянная степень затемнения | number / DIN | primary | P0 |
| `mask_filter_width_mm` | Ширина стекла | number / мм | advanced | P0 |
| `mask_filter_height_mm` | Высота стекла | number / мм | advanced | P0 |
| `mask_filter_replaceable` | Сменный светофильтр | boolean | advanced | P1 |
| `mask_body_material` | Материал корпуса | enum | advanced | P1 |
| `mask_helmet_attachment` | Крепление к каске | boolean | advanced | P1 |

#### 35. Краги и перчатки сварщика — `welding_gloves`

Корневой раздел: **Защита сварщика**; процесс: Welding gloves.

| Поле (`key`) | Характеристика | Тип / единица | Фильтр | Этап |
|---|---|---|---|---|
| `gloves_standard` | Маркировка стандарта по документации | text | advanced | P0 |
| `gloves_size` | Размер | enum | primary | P0 |
| `gloves_material` | Материал (спилок/кожа) | enum | primary | P0 |
| `gloves_length_cm` | Длина | number / см | advanced | P0 |
| `gloves_welding_process` | Назначение TIG/MIG/MMA | enum_list | primary | P0 |
| `gloves_heat_resistance` | Подтверждённый уровень защиты | text | advanced | P0 |

#### 36. Костюмы, куртки, нарукавники сварщика — `workwear`

Корневой раздел: **Защита сварщика**; процесс: Welding PPE.

| Поле (`key`) | Характеристика | Тип / единица | Фильтр | Этап |
|---|---|---|---|---|
| `ppe_type` | Вид СИЗ | enum | primary | P0 |
| `ppe_size` | Размер/рост | enum | primary | P0 |
| `ppe_material` | Материал | enum | primary | P0 |
| `ppe_protection_standard` | Маркировка защитного стандарта | text | advanced | P0 |
| `ppe_protection_class` | Класс защиты (если есть) | text | advanced | P0 |
| `ppe_fastener` | Тип застёжки | enum | advanced | P1 |

#### 37. Вытяжки сварочных аэрозолей — `fume_extraction`

Корневой раздел: **Оборудование и аксессуары**; процесс: Fume extraction.

| Поле (`key`) | Характеристика | Тип / единица | Фильтр | Этап |
|---|---|---|---|---|
| `extractor_airflow_m3_h` | Расход воздуха | number / м³/ч | primary | P0 |
| `extractor_filtration_class` | Класс фильтра | text | primary | P0 |
| `extractor_arm_length_m` | Длина рукава | number / м | advanced | P0 |
| `extractor_power_w` | Потребляемая мощность | number / Вт | advanced | P1 |
| `extractor_filter_area_m2` | Площадь фильтра | number / м² | advanced | P1 |
| `extractor_capture_type` | Тип улавливания | enum | primary | P1 |

#### 38. Выносные подающие механизмы — `wire_feeder`

Корневой раздел: **Оборудование и аксессуары**; процесс: Wire feeder.

| Поле (`key`) | Характеристика | Тип / единица | Фильтр | Этап |
|---|---|---|---|---|
| `feeder_rollers` | Число роликов | integer / шт | primary | P0 |
| `feeder_wire_diameters_mm` | Диаметры проволоки | number_list / мм | primary | P0 |
| `feeder_speed_min_m_min` | Мин. скорость | number / м/мин | advanced | P0 |
| `feeder_speed_max_m_min` | Макс. скорость | number / м/мин | advanced | P0 |
| `feeder_spool_mass_kg` | Максимальная катушка | number / кг | primary | P0 |
| `feeder_source_compatibility` | Совместимые источники | enum_list | primary | P0 |
| `feeder_cooling` | Поддержка охлаждения горелки | enum | advanced | P1 |
| `feeder_connector` | Соединение со сварочным источником | enum | advanced | P0 |

#### 39. Блоки водяного охлаждения горелок — `water_cooler`

Корневой раздел: **Оборудование и аксессуары**; процесс: Water cooler.

| Поле (`key`) | Характеристика | Тип / единица | Фильтр | Этап |
|---|---|---|---|---|
| `cooler_capacity_kw` | Мощность охлаждения | number / кВт | primary | P0 |
| `cooler_flow_l_min` | Расход жидкости | number / л/мин | advanced | P0 |
| `cooler_tank_l` | Объём бака | number / л | advanced | P0 |
| `cooler_pressure_bar` | Рабочее давление | number / бар | advanced | P0 |
| `cooler_power_v` | Напряжение питания | number / В | primary | P0 |
| `cooler_connectors` | Типы разъёмов | enum_list | advanced | P0 |
| `cooler_equipment_compatibility` | Совместимые источники/горелки | enum_list | primary | P0 |
| `cooler_fluid_type` | Допустимая охлаждающая жидкость | text | none | P1 |

#### 40. Магнитные угольники, держатели — `welding_magnets`

Корневой раздел: **Оборудование и аксессуары**; процесс: Fixture magnet.

| Поле (`key`) | Характеристика | Тип / единица | Фильтр | Этап |
|---|---|---|---|---|
| `magnet_holding_force_kgf` | Усилие удержания по изготовителю | number / кгс | primary | P0 |
| `magnet_angles_deg` | Углы позиционирования | number_list / ° | primary | P0 |
| `magnet_switchable` | Отключаемый магнит | boolean | advanced | P1 |
| `magnet_dimensions_mm` | Габариты | text / мм | advanced | P1 |

#### 41. Сварочные столы и оснастка — `welding_table`

Корневой раздел: **Оборудование и аксессуары**; процесс: Welding table.

| Поле (`key`) | Характеристика | Тип / единица | Фильтр | Этап |
|---|---|---|---|---|
| `table_length_mm` | Длина рабочей поверхности | number / мм | primary | P0 |
| `table_width_mm` | Ширина поверхности | number / мм | primary | P0 |
| `table_height_mm` | Высота стола | number / мм | advanced | P0 |
| `table_hole_diameter_mm` | Диаметр системных отверстий | number / мм | primary | P0 |
| `table_hole_pitch_mm` | Шаг отверстий | number / мм | primary | P0 |
| `table_load_kg` | Допустимая нагрузка | number / кг | advanced | P1 |
| `table_flatness` | Допуск плоскостности | text | advanced | P1 |

#### 42. Газовые сварочные горелки и резаки — `oxy_torch`

Корневой раздел: **Газовая сварка и резка**; процесс: Oxy-fuel.

| Поле (`key`) | Характеристика | Тип / единица | Фильтр | Этап |
|---|---|---|---|---|
| `oxy_tool_type` | Горелка/резак | enum | primary | P0 |
| `oxy_fuel_gases` | Допустимый горючий газ (ацетилен/пропан и др.) | enum_list | primary | P0 |
| `oxy_oxygen_pressure_bar` | Диапазон давления O₂ | text / бар | advanced | P0 |
| `oxy_fuel_pressure_bar` | Давление горючего газа | text / бар | advanced | P0 |
| `oxy_cut_thickness_range_mm` | Диапазон толщин с указанным соплом | text / мм | primary | P0 |
| `oxy_connector_o2` | Присоединение кислорода | enum | advanced | P0 |
| `oxy_connector_fuel` | Присоединение горючего газа | enum | advanced | P0 |
| `oxy_tip_compatibility` | Серии совместимых мундштуков | enum_list | primary | P0 |

#### 43. Газовые мундштуки и сопла резаков — `oxy_cut_nozzle`

Корневой раздел: **Газовая сварка и резка**; процесс: Oxy nozzle.

| Поле (`key`) | Характеристика | Тип / единица | Фильтр | Этап |
|---|---|---|---|---|
| `oxy_nozzle_fuel` | Для какого горючего газа | enum | primary | P0 |
| `oxy_nozzle_torch_family` | Совместимые резаки | enum_list | primary | P0 |
| `oxy_nozzle_cut_min_mm` | Минимальная толщина реза | number / мм | primary | P0 |
| `oxy_nozzle_cut_max_mm` | Максимальная толщина реза | number / мм | primary | P0 |
| `oxy_nozzle_part_code` | Код производителя | text | primary | P0 |
| `oxy_nozzle_attachment` | Присоединительный размер | text | advanced | P0 |

#### 44. Редукторы/расходомеры/подогреватели газа — `gas_regulator`

Корневой раздел: **Газовая сварка и резка**; процесс: Gas regulator.

| Поле (`key`) | Характеристика | Тип / единица | Фильтр | Этап |
|---|---|---|---|---|
| `regulator_gas` | Назначение по газу (O₂/Ar/CO₂/топливо) | enum | primary | P0 |
| `regulator_inlet_pressure_max_bar` | Макс. давление на входе | number / бар | advanced | P0 |
| `regulator_outlet_pressure_range_bar` | Диапазон давления на выходе | text / бар | advanced | P0 |
| `regulator_flow_range_l_min` | Диапазон расхода газа | text / л/мин | primary | P0 |
| `regulator_cylinder_thread` | Подключение баллона | text | primary | P0 |
| `regulator_hose_fitting` | Подключение шланга | text | advanced | P0 |
| `regulator_heater_power_w` | Потребляемая мощность подогревателя | number / Вт | advanced | P1 |
| `regulator_heater_voltage_v` | Напряжение питания подогревателя | number / В | advanced | P1 |

#### 45. Газовые рукава и соединители — `gas_hose`

Корневой раздел: **Газовая сварка и резка**; процесс: Gas hose.

| Поле (`key`) | Характеристика | Тип / единица | Фильтр | Этап |
|---|---|---|---|---|
| `hose_gas` | Назначение по газу | enum | primary | P0 |
| `hose_inner_diameter_mm` | Внутренний диаметр | number / мм | primary | P0 |
| `hose_length_m` | Длина | number / м | primary | P0 |
| `hose_work_pressure_bar` | Рабочее давление | number / бар | advanced | P0 |
| `hose_standard_marking` | Нормативная маркировка | text | advanced | P1 |
| `hose_fittings` | Фитинги/резьба | enum_list | advanced | P0 |

#### 46. Воздушные компрессоры для плазморезов — `air_compressor`

Корневой раздел: **Генераторы и компрессоры**; процесс: Air compressor.

| Поле (`key`) | Характеристика | Тип / единица | Фильтр | Этап |
|---|---|---|---|---|
| `compressor_delivered_air_l_min` | Фактическая производительность на выходе | number / л/мин | primary | P0 |
| `compressor_pressure_bar` | Рабочее давление | number / бар | primary | P0 |
| `compressor_receiver_l` | Объём ресивера | number / л | advanced | P0 |
| `compressor_motor_power_kw` | Мощность двигателя | number / кВт | advanced | P0 |
| `compressor_oil_free` | Безмасляный | boolean | advanced | P1 |
| `compressor_dryer_filter` | Осушитель/фильтр | boolean | advanced | P1 |
| `compressor_mains_v` | Напряжение питания | number / В | primary | P0 |

#### 47. Газовые баллоны, переходники, тележки — `gas_cylinder`

Корневой раздел: **Газовая сварка и резка**; процесс: Gas cylinders.

| Поле (`key`) | Характеристика | Тип / единица | Фильтр | Этап |
|---|---|---|---|---|
| `cylinder_gas_type` | Тип газа (не взаимозаменять подключения) | enum | primary | P0 |
| `cylinder_capacity_l` | Водяной объём баллона | number / л | primary | P0 |
| `cylinder_pressure_bar` | Рабочее давление (если задано) | number / бар | advanced | P0 |
| `cylinder_valve_thread` | Тип вентиля/резьбы | text | primary | P0 |
| `cylinder_service_status` | Сведения о поверке/освидетельствовании (для конкретного экземпляра) | text | none | P1 |
| `cylinder_empty_weight_kg` | Масса пустого баллона | number / кг | advanced | P1 |

#### 48. Припои и флюсы для пайки — `brazing_solder`

Корневой раздел: **Другие товары для сварки и резки**; процесс: Brazing.

| Поле (`key`) | Характеристика | Тип / единица | Фильтр | Этап |
|---|---|---|---|---|
| `brazing_alloy` | Класс/состав припоя | text | primary | P0 |
| `brazing_product_form` | Пруток/проволока/паста | enum | primary | P0 |
| `brazing_diameter_mm` | Диаметр/размер | number / мм | primary | P0 |
| `brazing_melting_range_c` | Интервал плавления | text / °C | advanced | P0 |
| `brazing_flux_type` | Тип флюса | enum | advanced | P0 |
| `brazing_base_materials` | Назначение по материалам | enum_list | advanced | P0 |
| `package_net_mass_kg` | Масса упаковки | number / кг | advanced | P1 |

## 5. Профессиональная проверка сварочной теории — блокирующие правила

**R01 — Разные процессы не объединять.** Нет общего «максимального тока» для MMA/MIG/TIG/CUT: отдельные значения, диапазоны, ПН, режимы.

**R02 — ПН с условиями.** ПН в % без номинального тока и температуры не является сопоставимой характеристикой. Не выводить 100% ток расчётом.

**R03 — Токи и входная сеть.** Номинальные 220/230/380/400 В, фазность, рабочие границы, требуемый сетевой ток и автомат — разные параметры.

**R04 — Мощность.** кВт (активная) и кВА (полная) — разные размерности; не переименовывать одну в другую.

**R05 — TIG и алюминий.** TIG DC и TIG AC/DC не равнозначны для обычной сварки алюминия; не выводить AC только из названия TIG.

**R06 — MIG алюминий.** Возможность MIG сварки Al зависит от аппарата, проволоки, подающей системы/канала, горелки, газа и настроек.

**R07 — FCAW газ.** Порошковая самозащитная и газозащитная проволока — разные классы; «без газа» нельзя присваивать всей FCAW.

**R08 — Плазморез.** Рекомендуемый/качественный, предельный, прожиг и скорость реза — разные параметры; сохранять материал/условия.

**R09 — Воздух CUT.** Воздушный расход и давление совместно; компрессор выбирать по фактической отдаче при давлении, не по объёму ресивера.

**R10 — Горелка MIG.** Номинальный ток горелки указывать с газом (CO₂/смесь), охлаждением и ПН; соединение EURO не обеспечивает универсальность расходников.

**R11 — Расходники.** Наконечник М6/М8, диаметр отверстия, длина, серия горелки и держатель имеют разные значения; не угадывать совместимость.

**R12 — Электроды.** Классификация, тип покрытия, диаметр, полярность и токовый диапазон конкретного диаметра — отдельные поля.

**R13 — Проволока.** Марка, диаметр, формат катушки и масса являются вариантными SKU; «максимальный сварочный ток» на маркетплейсе не обязательное свойство проволоки.

**R14 — Маски.** Светлый DIN, тёмный диапазон, оптический класс, зона обзора и сенсоры — различные свойства; время срабатывания с температурой.

**R15 — Газ.** Кислородные, аргоновые, CO₂ и горючие редукторы/разъёмы не считать взаимозаменяемыми без документов.

**R16 — Типоразмеры.** Диаметр электрода/проволоки (мм), сечение кабеля (мм²), расход газа (л/мин), сжатый воздух (л/мин, бар) — разные сущности.

**R17 — Неизвестно ≠ нет.** Отсутствующее значение параметра = unknown; false только после проверки; запрещать вывод по отсутствию поля.

**R18 — Пруф на SKU.** У каждого подтверждённого значения источник URL/PDF, точная ревизия/артикул, дата проверки, статус и (для PDF) страница.

**R19 — Список совместимости.** Предлагаемая связка аппарат→горелка→ролик→проволока→наконечник и пр. требует подтверждённой модели/разъёмов.

**R20 — Маркетплейс не первоисточник.** Ozon/отзывы полезны для UX и обнаружения полей, но спорные технические сведения сверять с производителем.

**R21 — Модификации.** Проверять, меняется ли не только стоимость, но и номер изделия, катушка/диаметр/упаковка/комплектность.

**R22 — Не продавать ложную точность.** Не вычислять пригодность материала/толщины без подтверждённой таблицы технологических режимов.

**R23 — Безопасность.** В фильтрах СИЗ использовать только документированную маркировку соответствия; избегать обещаний защиты вне условий производителя.

**R24 — Нет скрытой автоматической публикации.** Импорт прайсов не должен менять published и решение «продаём/не продаём» без аудируемого подтверждения.

**R25 — Данные сторонних сайтов.** Собирать доступные характеристики с учётом законных ограничений, robots/terms; не копировать фотографии/тексты без оценки прав.

## 6. Демонстрация на реальных моделях (первичные источники)

Для указанных моделей **значения приводятся только по указанным документам**. У разных ревизий/артикулов характеристики могут отличаться. Не заполнять таким образом соседние модификации.

| Модель | Документированное значение | Урок для фильтров | Источник |
|---|---|---|---|
| Сварог REAL SMART MIG 200 N2A5 | MIG 30–200A; MMA 20–160A; TIG DC 20–180A; 220V; рабочий диапазон 120–270V; ПН 60% при 40°C; ток ПН100% MIG 155A, MMA 140A, TIG 150A; проволока 0,6/0,8/1,0мм; катушка до 5кг | Вывод: нельзя хранить одно общее max_current для всех процессов; 100% ток не равен максимальному | [Документ](https://svarog-rf.ru/products/real-smart-mig-200/specs) |
| Сварог REAL TIG 200 P AC/DC E20101 | TIG 5–200A; MMA 10–160A; AC/DC; высокочастотный поджиг; ПН 60% при 40°C | Показать TIG AC/DC как отдельную характеристику, а не вывод из слова TIG | [Документ](https://svarog-rf.ru/products/real-tig-200-p-acdc/specs) |
| Сварог REAL ARC 200 Z2K6 | MMA 20–200A; ПН 60% при 40°C; непрерывный ток 160A; электроды 1,6–4мм | Для токового фильтра отличать максимальный и непрерывный ток | [Документ](https://svarog-rf.ru/products/real-arc-200-z2k6/specs) |
| Сварог REAL CUT 45 L2A1 | Ток CUT 20–45A; воздух 100 л/мин при 0,4МПа; заявлена макс. толщина 12мм | Не подменять рекомендованную толщину максимальной и наоборот | [Документ](https://svarog-rf.ru/products/real-cut-45-l2a1/specs) |
| Hypertherm Powermax45 SYNC | Рекомендованный рез 16мм при 500 мм/мин; предельный разделительный 29мм при 125 мм/мин; прожиг 12мм | Три несводимые характеристики: recommended, severance, pierce; плюс скорость | [Документ](https://www.hypertherm.com/resources/resources-by-product/?ProductCode=POWERMAX45+SYNC) |
| BINZEL MB GRIP 15 AK | Ток горелки CO₂ 180A и смесь M21 150A при ПН60%; проволока 0,6–1,0мм | Ток горелки зависит от защитного газа и ПН; отдельно от тока источника | [Документ](https://www.binzel-abicor.com/DE/eng/products/manual/migmag-torches/welding-torch-mb-grip/) |
| ESAB OK 46.00 E6013 | Рутилово-целлюлозное покрытие; рекомендуемые токи зависят от диаметра: для 2,5мм 60–100A, 3,2мм 80–150A | Электрод — не сварочный источник; токовые диапазоны привязаны к конкретному диаметру | [Документ](https://esab.com/ie/eur_en/products-solutions/product/filler-metals/mild-steel/stick-electrodes-smaw/ok-46-00/) |
| 3M Speedglas G5-01TW 61 00 20 | Светлое состояние DIN3; затемнение DIN8–13; оптический класс 1/1/1/1; 4 сенсора; время 0,1мс при +23°C | Оптический класс — 4 позиции; время реакции требует температуры измерения | [Документ](https://multimedia.3m.com/mws/media/1798406O/pdf-3m-speedglas-welding-filter-series-g5-01-technical-datasheet.pdf) |

## 7. Модель данных для DevSpace (проект миграции; НЕ применено)

**Сохраняем обратную совместимость** `products.specs`, существующих `products`, категорий и импортов. Новые структуры — только добавочные миграции после review в DEV:

- `product_families(id, code, name, parent_id?, process)` и `category_family_mapping(category_id, family_id)`. Одной категории могут соответствовать разные семейства, но карточка имеет **одно первичное** семейство, если не подтверждён состав/комплект. Товары в родительских разделах не терять.
- `attribute_definitions(id, code, label, value_type, canonical_unit, filter_kind, is_public, validation_rule, ...)` и `family_attribute_rules(family_id, attribute_id, requiredness, filter_priority, display_group, sort_order)`. Коды глобально стабильны. `code` из словаря JSON этого пакета. Рекомендуемые `enum_list`, `number_list`, `mode_map` **не** хранить неразобранными строками для фасетов: нормализовать в отдельные строки/таблицы или типизированный JSONB + серверный валидатор и индексы.
- `product_attribute_values(id, product_id, attribute_id, num_value, bool_value, text_value, enum_value, unit, verification_state, source_id, observed_at, updated_by)`; ограничение **ровно один тип значения**, уникальность `(product_id, attribute_id, ordinal)` для многозначных полей. Важное: `false` отличается от `unknown`.
- `process_performance(product_id, process_code, polarity, output_current_min_a, output_current_max_a, duty_cycle_pct, duty_current_a, duty_temp_c, continuous_current_a, ...)`: строго не смешивать MMA/MIG/TIG/CUT. Если ПН заданы при нескольких токах, **одна запись на комбинацию процесс + условия**.
- `product_variants(product_id, parent_product_id?, sku, ean?, manufacturer_article, variant_keys JSONB, price, stock...)` или reuse существующих `products` как отдельные SKU со связью `variant_group_id`, если это меньше меняет систему. У поставщиков артикулы могут повторяться; не строить PK лишь на сыром SKU.
- `technical_sources(id, product_id, manufacturer_id?, url, document_kind, document_revision, document_page, checked_at, reviewer, origin, confidence)` и `attribute_evidence(attribute_value_id, source_id, source_quote_locator, review_status)`. Для конфликтов сохранять оба источника и блокировать автопубликацию.
- `compatibility_relations(id, from_product_id, to_product_id, relation_type, qualifier, source_id, status)` и/или `compatibility_interfaces` (например `mig_torch_connector`, `mig_tip_thread`, `mig_torch_series`, `liner_wire_range`); любые рекомендации с `status=verified`, запрещать вывод только из похожего названия.
- `search_synonyms(alias, normalized_query, family_code?, brand_code?)` и серверный facets API/RPC с allowlist фильтров, пагинацией, сортировкой, индексами по `(attribute_id, num_value)`, `(attribute_id, enum_value)` и проверенными RLS. Секретные закупочные цены — отдельно от публичных представлений. Прямой перебор всех товаров и атрибутов в React не масштабируется.

**Неизменяемость смыслов:** `source_id` и проверенное значение сохраняются при импорте новой версии; обновление без первичного подтверждения переводит значение `pending_review`, не молча подменяет. Внутренние поля цен/поставщиков не попадают в публичную выдачу. Новая миграция не касается Cloud/production до отдельной авторизации.

## 8. UX-контракт карточки

1. Заголовок: точная модель, артикул, бренд, фото **именно варианта**, наличие, цена, «Запросить цену/срок» при отсутствии точной цены.
2. Плашки до первого скролла **только 3–5** релевантных фактов: MIG ток/напряжение/проволока; маска DIN/оптический класс; наконечник серия/резьба/диаметр.
3. Блок «Как работает» (процессы/материал, ограничения; без неподтверждённых обещаний).
4. Характеристики **группами**: питание; сварочные процессы; токи и ПН; подача; соединения; расходники; размеры; эксплуатация. Не показывать пустые характеристики.
5. **Совместимые** горелки/проволока/электроды/наконечники по подтверждённым отношениям. «Похожие» и «Совместимые» — две разные витрины.
6. Комплектация, инструкция PDF, гарантия, подтверждённые документы, источник/дата проверки важных параметров. Документы не требуют выхода с сайта при просмотре.
7. Для вариантов: переключение меняет SKU, характеристики, цену, наличие, фото и URL атомарно; не «создавать впечатление» одного товара, если фактически разные модификации.
8. Стойкие ссылки: фильтры и прокрутка/пагинация возвращаются при «Назад». Телефон: кнопка фильтра, отдельная прокручиваемая панель, чипы, 44px+ touch targets как рекомендация UX.

## 9. Импорт и обогащение — запрет на публикацию предположений

**Pipeline:** XLSX/CSV/PDF/скан → извлечение с сохранением оригинала → идентификаторы и вариант SKU → классификация семейства → сопоставление словаря атрибутов → нормализация единиц → проверки R01–R25 → сверка первоисточника → предпросмотр diff `было/стало` с источниками → отдельное подтверждение → атомарная запись с аудитом и возможностью отката → карточка в черновике/на проверке → публикация отдельно по полномочию владельца.

Текущая реализация DevSpace поддерживает **CSV**, а XLSX/PDF/фото и автозаполнение атрибутов ещё не являются готовыми функциями. Existing CSV import не должен изменять цену/статус/ассортимент неожиданно. Не искать и не генерировать фотографию как доказательство конкретной модели. Цены конкурентов и фотографии отделить от технического подтверждения.

## 10. План внедрения (P0 → P3)

| Приоритет | Задача | Definition of Done |
|---|---|---|
| **P0. Словарь + источники** | Утвердить 10 ключевых семейств, определить типы/единицы; отобрать 50–100 SKU и первичные паспорта; доп. схема в DEV | Для каждого SKU: идентичность модели, provenance, явные unknown; существующие карточки/поиск не сломаны |
| **P1. Карточка + ввод** | Типизированные значения, staff preview/confirm/audit, PDF-документы, режимные измерения, разновидности SKU; 5 первых категорий | Тесты валидности и RLS; 100% проверенных опубликованных значений **в пилотной выборке**, не во всём каталоге |
| **P2. Умные фасеты** | Серверные индексированные фильтры MMA/MIG/TIG/CUT/маски/проволоки, синонимы, URL, мобильная панель, сравнение | Фильтры не показывают отсутствующие значения как «Нет»; результаты совпадают с SQL и видимым ассортиментом |
| **P3. Совместимость + расширение** | Горелки/наконечники/ролики/катушки/газ + остальные семейства, подбор по работе, конвейер XLSX/PDF/изображений | Нет ложных «совместимо»; конфликтные автоматические извлечения блокируются до подтверждения; проверены производительность и откат |

**Подробные acceptance tests**: применимость полей семейства, разделённые режимные токи, точные единицы, фасеты AND между разными свойствами / OR внутри одного, диапазон 0.6/0.8/1.0 без ложной интерполяции, отсутствие значений, ПН с температурой, кВт vs кВА, AC/DC, рекомендованный vs предельный рез, валидность газового назначения, совместимость по сериям, статусы черновик/исключено, RLS/цены закупки, URL-контекст, 320/390/1440px, задержка поиска на реальном объёме данных, rollback и отказ при конкурентном редактировании.

## 11. Сценарии первого выпуска — ориентир для разработчика

- «Полуавтомат 220 В / проволока 0,8 мм / газ/без газа»: фильтровать по MIG, однофазной сети, поддерживаемому диаметру **в списке**, газовому типу проволоки/смене полярности, без смешения с MMA.
- «TIG алюминий, HF»: TIG AC/DC и документированная функция HF + диапазон тока, без попытки считать обычный TIG DC равным AC/DC.
- «Электрод E6013 3,2 мм»: требуются классификация, покрытие, диаметр, упаковка; рекомендуемый ток берётся из спецификации этого диаметра.
- «Наконечник M6 под 0,8 мм»: резьба + серия горелки + длина + диаметр проволоки; описание без проверенной серии не даёт статуса совместимости.
- «Плазморез рекомендуемый рез 12 мм»: фильтр **только** по `cut_recommended_thickness_mm`, а наличие числа в поле `cut_severance_thickness_mm` не подменяет критерий.
- «Маска для TIG на малом токе»: тип АСФ, заявленная работа на малом токе, документированные датчики, диапазон DIN и оптический класс; не делать безопасность на основании отзывов.

## 12. Как провести масштабный аудит всего ассортимента (техническое задание сборщику)

Сборщик обходит разрешённые сайты по дереву: **корень → категория → подкатегория → листинг → страницы каждой подтверждённой модели/варианта → вкладки «Технические характеристики», «Комплектация», «Документы», «Совместимо»**. Регистрирует URL, дату, модель, производителя, артикул, доступность страницы, каждую характеристику отдельно с исходной формулировкой, нормализованным полем, единицей и доказательством. Контроль полноты: число просмотренных страниц, ошибок, пропущенных JS-вкладок, неоднозначных SKU, нераспознанных полей. Каждая недоступная страница помечается, а не считается изученной.

**Приоритет источников:** паспорт/техдок производителя → официальный сайт производителя → каталог официального дистрибьютора → независимый магазин → Ozon/маркетплейсы → отзывы/форумы (лишь для выявления потребностей и ошибок, не для числовой спецификации). Исходные извлечения не публиковать без проверки. Большой объём работы должен быть автоматизирован, но проверка неоднозначного SKU остаётся обязательной.

## 13. Исходники и ссылки

| ID | Документ/раздел | Роль | URL |
|---|---|---|---|
| S01 | ВсеИнструменты: полуавтоматы | Ритейлер, фильтры | https://www.vseinstrumenti.ru/category/svarochnye-poluavtomaty-463/ |
| S02 | ВсеИнструменты: инверторы | Ритейлер, фильтры | https://www.vseinstrumenti.ru/category/svarochnye-apparaty-invertory-465/ |
| S03 | ВсеИнструменты: TIG | Ритейлер, фильтры | https://www.vseinstrumenti.ru/category/argonovaya-argonnaya-svarka-tig-1294/ |
| S04 | ВсеИнструменты: проволока | Ритейлер, фильтры | https://www.vseinstrumenti.ru/category/svarochnaya-provoloka-3855/ |
| S05 | Ozon: сварочное оборудование | Маркетплейс, категории и варианты | https://www.ozon.ru/category/svarochnoe-oborudovanie-10046/ |
| S06 | Ozon: DEKA ER70S-6 | Маркетплейс, вариативность диаметра и массы | https://www.ozon.ru/product/omednennaya-svarochnaya-provoloka-deka-er70s-6-sv-08g2s-o-1-mm-5-kg-dlya-poluavtomatov-pri-rabote-s-335291976/ |
| S07 | АССВАР: горелки и комплектующие | Ритейлер, дерево | https://assvar.ru/products/category/1927873 |
| S08 | Сварочник: полуавтоматы | Ритейлер, навигация | https://svarochnik.ru/svarochnyj-poluavtomat |
| S09 | Сварог REAL SMART MIG200 | Производитель, первичная спецификация | https://svarog-rf.ru/products/real-smart-mig-200/specs |
| S10 | Сварог REAL TIG200 AC/DC | Производитель, первичная спецификация | https://svarog-rf.ru/products/real-tig-200-p-acdc/specs |
| S11 | Сварог REAL ARC200 | Производитель, первичная спецификация | https://svarog-rf.ru/products/real-arc-200-z2k6/specs |
| S12 | Сварог REAL CUT45 | Производитель, первичная спецификация | https://svarog-rf.ru/products/real-cut-45-l2a1/specs |
| S13 | Hypertherm Powermax45 SYNC | Производитель, типы реза и скорости | https://www.hypertherm.com/resources/resources-by-product/?ProductCode=POWERMAX45+SYNC |
| S14 | Binzel MB GRIP | Производитель, MIG горелки | https://www.binzel-abicor.com/DE/eng/products/manual/migmag-torches/welding-torch-mb-grip/ |
| S15 | Binzel ABITIG GRIP | Производитель, TIG горелки | https://www.binzel-abicor.com/DE/eng/products/manual/tig-welding-torches/welding-torch-abitig-grip-9-26/ |
| S16 | GCE BASECONTROL | Производитель, газовые редукторы | https://www.gcegroup.com/en/products/basecontrol-flow |
| S17 | ESAB OK 46.00 | Производитель, электроды и классы | https://esab.com/ie/eur_en/products-solutions/product/filler-metals/mild-steel/stick-electrodes-smaw/ok-46-00/ |
| S18 | 3M Speedglas G5-01 | Производитель, PDF Rev 2022-06-22 | https://multimedia.3m.com/mws/media/1798406O/pdf-3m-speedglas-welding-filter-series-g5-01-technical-datasheet.pdf |
| S19 | Miller: equipment | Производитель, выбор по материалу | https://www.millerwelds.com/en-us/equipment?CatID=Equipment |
| S20 | IEC 60974-1:2021 | Международный стандарт на источники | https://webstore.iec.ch/en/publication/64782 |
| S21 | ISO 14175:2008 | Стандарт классификации защитных газов | https://www.iso.org/standard/39569.html |
| S22 | ISO 2560:2020 | Стандарт на электроды для сварки | https://www.iso.org/standard/79320.html |

## 14. Границы уверенности

- В файл включена **концепция атрибутов** на основании отраслевой теории, опубликованных спецификаций и UX сопоставления; он **не является базой проверенных характеристик для 1038 SKU**.
- Из браузерных страниц выявлены отдельные реальные свойства и UX-механики; **не доказано**, что все страницы каждого конкурента доступны/обойдены и все фильтры на всех экранах работают одинаково.
- Отдельные URL/названия стандартов следует перепроверить на дату внедрения и для рынка/сертификации конкретной продукции. Стандарты здесь не объявляются нормативной обязанностью РФ сами по себе.
- DevSpace и production-код не изменены; автоматический импорт/фасетный API в этом документе — **предложения**.

**Сопутствующие файлы:** `MasterWeld_Attribute_Dictionary_v1.json` (машинный словарь), `MasterWeld_Attribute_Matrix_v1.xlsx` (табличный handoff), `MasterWeld_Attributes_All.csv` (строчная выгрузка полей).
