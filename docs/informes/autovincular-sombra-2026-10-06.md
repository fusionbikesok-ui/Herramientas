# Auto-vinculación en modo sombra: propuesta

Generado en solo lectura desde `fusion.sqlite`. **No se escribió ningún vínculo, decisión, caso ni operación.**

Universo: publicaciones de ML con `seller_sku` FB-… que existe en Woo, sin identidad activa y sin decisión «omitir».

| | Total | Activas | Pausadas |
|---|---:|---:|---:|
| Universo | 1552 | 118 | 1434 |
| Seguras (sin ninguna señal de riesgo) | 767 | 77 | 690 |
| A revisar | 785 | 41 | 744 |

Motivos para revisar (una fila puede tener varios):

- N publicaciones de ML comparten este SKU: 752
- GTIN de ML distinto al de Woo: 75
- título contradice a Woo: 19
- caso de identidad abierto: 10

## Muestra de 20 para revisar (semilla 20261006, reproducible, solo activas)

| # | Estado | Clave ML | Título en ML | SKU | Producto en Woo | Stock ML / Woo | Veredicto |
|---:|---|---|---|---|---|---|---|
| 1 | active | MLA1653096091|197915355179 | Bicicleta Mtb Volta Zilant Race - 1x12 Shimano Deore Carbono | FB-47905 | Bicicleta MTB R29 Volta ZILANT Race - 1X12 Shimano Deore - Carbono — M / Beige (Woo 47905) | 0 / 0 | segura |
| 2 | active | MLA1469054615|182635572854 | Zapatilla Ciclismo Metha Xc Epic - Mtb - Shimano Compatible | FB-26527 | Zapatillas Metha Xc Epic — Negro / 44 (Woo 26527) | 0 / 0 | segura |
| 3 | active | MLA1469054615|182635572880 | Zapatilla Ciclismo Metha Xc Epic - Mtb - Shimano Compatible | FB-26548 | Zapatillas Metha Xc Epic — Rojo / 42 (Woo 26548) | 0 / 0 | segura |
| 4 | active | MLA877443722|173547836656 | Casco Giro Agilis Mips - Fusion Bikes | FB-7254 | Casco Giro Agilis Mips — Negro/Rojo / S (51-55cm) (Woo 7254) | 0 / 0 | segura |
| 5 | active | MLA1653096091|197915355177 | Bicicleta Mtb Volta Zilant Race - 1x12 Shimano Deore Carbono | FB-47904 | Bicicleta MTB R29 Volta ZILANT Race - 1X12 Shimano Deore - Carbono — L / Beige (Woo 47904) | 0 / 0 | segura |
| 6 | active | MLA1111588345|173890905408 | Remera Oakley Graffiti 1975 | FB-29273 | Remera Oakley Graffiti 1975 — Blanco / M (Woo 29273) | 0 / 0 | segura |
| 7 | active | MLA1401191041|181299399273 | Lentes Poc Devour - Fusion Bikes | FB-15658 | Lentes Poc Devour — Transparent Crystal/Clarity MTB Silver Mirror Cat 2 (Woo 15658) | 0 / 0 | segura |
| 8 | active | MLA1436018870|178033310754 | Zapatilla Shimano Xc902 | FB-8931 | Zapatillas Shimano Xc902 — Negro / 45 (Woo 8931) | 0 / 0 | segura |
| 9 | active | MLA1157345479|175100646364 | Chaleco Magenta 172 | FB-8011 | Chaleco Magenta 172 — Syrah / 12 (Woo 8011) | 0 / 0 | segura |
| 10 | active | MLA1469054615|182635572872 | Zapatilla Ciclismo Metha Xc Epic - Mtb - Shimano Compatible | FB-26525 | Zapatillas Metha Xc Epic — Blanco / 46 (Woo 26525) | 0 / 0 | segura |
| 11 | active | MLA885491375|186105574339 | Casco Bicicleta Rudy Project Spectrum | FB-25173 | Casco Rudy Project Spectrum — Blanco Mate / S (Woo 25173) | 0 / 0 | revisar: 2 publicaciones de ML comparten este SKU |
| 12 | active | MLA885491375|173599305214 | Casco Bicicleta Rudy Project Spectrum | FB-25174 | Casco Rudy Project Spectrum — Blanco Mate / M (Woo 25174) | 0 / 0 | revisar: 2 publicaciones de ML comparten este SKU |
| 13 | active | MLA1962666420|192038148651 | Bicicleta Zion Breva 21v L-twoo - Mtb Frenos A Disco | FB-25295 | Bicicleta MTB R29 Zion Breva - 3X7 L-Twoo A2 — Negro/Fucsia / S (Woo 25295) | 0 / 0 | revisar: GTIN de ML distinto al de Woo; 4 publicaciones de ML comparten este SKU |
| 14 | active | MLA885491375|186105574343 | Casco Bicicleta Rudy Project Spectrum | FB-25177 | Casco Rudy Project Spectrum — Negro mate / M (Woo 25177) | 0 / 0 | revisar: 3 publicaciones de ML comparten este SKU |
| 15 | active | MLA1970339676|187048996883 | Bicicleta Zion Breva 21v L-twoo - Mtb Frenos A Disco | FB-25294 | Bicicleta MTB R29 Zion Breva - 3X7 L-Twoo A2 — Azul/Celeste / L (Woo 25294) | 0 / 0 | revisar: 2 publicaciones de ML comparten este SKU |
| 16 | active | MLA2013471629| | Palanca Potenciometro Araña Magene Pes P515 170mm Negro | FB-67029 | Palanca Potenciometro de Ruta PES 515 - Magene (Woo 67029) | 1 / 1 | revisar: caso de identidad abierto (gtin_contradictorio/pendiente) |
| 17 | active | MLA877443722|63599981371 | Casco Giro Agilis Mips - Fusion Bikes | FB-7250 | Casco Giro Agilis Mips — Negro / M (55-59cm) (Woo 7250) | 0 / 0 | revisar: 2 publicaciones de ML comparten este SKU |
| 18 | active | MLA3983846604| | Bicicleta R29 Zion Ovanta 1x10 L-twoo Frenos Hidraulicos Azul M | FB-14723 | Bicicleta MTB R29 Zion Ovanta 1X10V — Azul / M (Woo 14723) | 3 / 3 | revisar: GTIN de ML distinto al de Woo; 5 publicaciones de ML comparten este SKU; caso de identidad abierto (gtin_contradictorio/urgente) |
| 19 | active | MLA1970339676|182392460310 | Bicicleta Zion Breva 21v L-twoo - Mtb Frenos A Disco | FB-25292 | Bicicleta MTB R29 Zion Breva - 3X7 L-Twoo A2 — Azul/Celeste / S (Woo 25292) | 0 / 0 | revisar: GTIN de ML distinto al de Woo; 2 publicaciones de ML comparten este SKU |
| 20 | active | MLA3983846592| | Bicicleta R29 Zion Ovanta 1x10 L-twoo Frenos Hidraulicos Gris S | FB-13630 | Bicicleta MTB R29 Zion Ovanta 1X10V — Gris / S (Woo 13630) | 4 / 4 | revisar: GTIN de ML distinto al de Woo; 4 publicaciones de ML comparten este SKU; caso de identidad abierto (gtin_contradictorio/urgente) |

## Qué falta para vincular de verdad
- Que alguien revise la muestra y confirme el criterio de «segura».
- La vinculación real va por Identidad (decisión con dueño, caso y operación), nunca desde este script.
