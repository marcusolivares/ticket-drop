# Sesc SP data sources

Sesc São Paulo has no documented public API. Everything here was found by inspecting the website, its scripts and the Credencial Sesc SP app, and was last checked on 2026-11-03. Any of it can change without notice.

Be gentle: this project waits at least one second between requests, sends an honest User-Agent, and only reads.

## Public endpoints used by this project

| Endpoint | Purpose |
|---|---|
| `www.sescsp.org.br/wp-json/wp/v1/atividades/filter` | Lists activities. Has dates but no sale times. |
| `www.sescsp.org.br/wp-json/wp/v1/atividades/detail?slug=<slug>` | Sale times, prices and ticket counts per session. |
| `www.sescsp.org.br/wp-json/wp/v1/unidades-atividades` | Units, with region (`capital`, `interior`, `litoral`) in `description`. |

To list plays:

```
/atividades/filter?tipo=atividade&linguagem=teatro&data_inicial=2026-11-03&data_final=2026-12-03&ppp=300&page=1&dinamico=true&sites=true
```

`linguagem=teatro` keeps only the Teatro sub-category of shows. Some shows have no sub-category, so they are missed: most are music, but a few may be plays. Using `atividade=shows-espetaculos-e-performances` instead returns all shows.

## Fields in `detail`

All in `sessoes[]`:

| Field | Meaning | Example |
|---|---|---|
| `dataInicialVendaOnlineFmt` | Online sale opens (São Paulo time) | `2026-11-10T17:00` |
| `dataInicialVendaRedeFmt` | In-person sale opens | `2026-11-11T17:00` |
| `dataFinalVendaOnlineFmt` | Online sale closes | `2026-11-18T18:00` |
| `dataInicialSessaoFmt` | Session start | `2026-11-18T20:00` |
| `qtdeIngressosWeb` / `qtdeIngressosRede` | Online / in-person tickets | `156` / `89` |
| `statusSessaoSesc` | `INDISPONIVEL`, `DISPONIVEL_WEB`, `DISPONIVEL_UNIDADE`, `ESGOTADO` | |
| `valorInteira` / `valorMeia` / `valorComerciario` | Full / half / Credencial Plena price | `40` / `20` / `12` |
| `urlCompra` | Purchase link, HTML-escaped (`&amp;`) | |
| `idSessao` | Session ID, used by the box office endpoints | `996156` |

Use the `*Fmt` fields. The matching epoch fields are not all reliable: `dataInicialSessao` is midnight on the session's date.

## Quirks

- **`detail` lags behind real sales by some minutes.** It reads from a search index. In one check, nine minutes after a sale opened it still showed `INDISPONIVEL` and pre-sale counts, while the box office showed sales already happening (21 listed, 12 left). By 18 minutes it showed that 12 and the new status, while the box office had moved on to 11. That's only one sale, so the exact refresh rate is unknown. Never use its status field to decide whether a sale is open: compare the sale time with the clock.
- **The box office endpoint returns 404 before a sale opens**, with the misleading message "A sessão informada está encerrada".
- **`detail` returns at most 20 sessions**, the earliest ones. `possuiMais20Sessoes` is the string `"true"` or `"false"`, not a boolean, so both values are truthy. `page`, `ppp`, `limit` and `per_page` have no effect. The listing's `datasSessoes` still has every date.
- **`detail` returns 404 for free activities** and for anything not in the search index.
- **New plays can appear only hours before their sale.** *A Avó Inventada* and *Cão* were missing from the API at about 13:00 and present at 16:57, for a sale opening at 17:00. A web page can exist before the API record does.
- **Errors can arrive as HTTP 200.** `/wp/v1/dinamico` returned an error message as a JSON string.
- **The listing's `qtdeIngressosWeb` is a total** across an activity's sessions.
- **Listings can contain `null` rows.** On 2026-11-04, the last two of 559 shows were `null`, and `total.value` still counted them.
- **Data glitches exist.** Examples: a session listed at `00:00`, and an in-person sale date earlier than the online one.
- **Sessions of one activity can open at different times, even on the same day.** On 2026-11-04, the Nov 29 session of *Farinha com Açúcar* opened at `2026-11-10T08:00` and its other six at `17:00`. Sesc's page shows the same times, so this isn't an API error. It was the only one of 68 plays checked that day. This project uses only the premiere's opening.

## The sale rule

The monthly booklets state the rule for all of Sesc São Paulo:

> A venda de ingressos para shows e espetáculos no Sesc São Paulo tem início semanalmente, em dois lotes. On-line: às terças-feiras, a partir das 17h. Presencial, nas bilheterias das unidades: quartas-feiras, a partir das 17h.

Activities from a given Monday to Sunday go on sale on the Tuesday of the week before. A season goes on sale all at once, based on its premiere. In-person sales move to the next working day after a holiday.

Tested on 2026-11-03:

- **Time:** 360 of 364 ticketed sessions opened online on a Tuesday at 17:00. The other 4 were music shows opening on the day itself.
- **Week:** 142 of 155 activities opened in the week the rule predicts.
- **In person:** 353 of 364 opened exactly 24 hours after online.

This covered theatre, music, dance and circus at the 33 of 43 units that had ticketed sessions. Bertioga's day pass and special programmes, such as the free Sesc 80 Anos tickets, follow other dates.

## Booklets

The booklets are PDFs, not API data:

- ***Em Cartaz*** is monthly highlights, mostly for the capital. [The archive](https://www.sescsp.org.br/editorial/emcartaz/) goes back to 2022.
- **Unit guides** (*Guia de Programação*) are linked from the carousel on each unit's page.

Neither source is complete. Only about half of the API's ticketed plays appeared in *Em Cartaz*, and *Em Cartaz* listed 8 ticketed plays the API didn't have yet. They can reach the API at very different times: *Cão* and *A Avó Inventada* arrived hours before their sale, and *Farinha com Açúcar* six days before.

The archive page lists editions newest first, and filenames vary, so take the first link rather than guessing a name.

### Reading *Em Cartaz*

The PDF's plain text is noisy, with page headers and photo captions mixed in. Fonts are the reliable signal. These held across the August, October and November 2026 editions, though the font names' prefixes change, so match the part after the `+`:

| Font | Size | Text |
|---|---|---|
| `Informative-Black` | 11 | Section headings, such as `TEATRO`, and also page numbers |
| `Informative-Medium` | 10 | Unit names, in capitals |
| `Informative-Bold` | 10 | Titles, including series headings such as `TEATRO MÍNIMO` |
| `Informative-SemiBold` | 10 | Titles of plays within a series, and photo captions |
| `Informative-SemiBold` | 8.5 | Schedules and prices |
| `Informative-Regular` | 10 | The second line of a photo caption |

Things to watch for:

- **Captions look like titles.** A caption is a title-styled line followed by a `Regular` 10 line. Treat it as a title and it takes the dates of the play it interrupts.
- **Sidebars can break sections.** "Artes Cênicas à Tarde" sits inside the dance section, so reading it as a theatre section pulls in dance pieces.
- **Plays in a series may have no price of their own,** and share the series heading's.
- **Printed dates can be wrong.** The November edition has *Farinha com Açúcar* from Nov 26, while the API has sessions from Nov 20.

## Other endpoints

Not used here, but useful to know about:

| Endpoint | Notes |
|---|---|
| `/wp/v1/atividades/search?s=<text>&tipo=atividade` | Fuzzy search, so totals are large and results loose. |
| `/wp/v1/grades-programacao` | The SescTV schedule, despite the name. Not the booklets. |
| `/wp/v2/search?search=<text>` | Finds posts and pages, including booklet posts. |
| `/wp/v2/media`, `/wp/v2/tipos_linguagens` | Return 401. |
| `portal.sescsp.org.br/bilheteria/sessaoAtividade.action?idSessao=<id>` | Live counts for a session on sale, ahead of `detail`. |
| `portal.sescsp.org.br/bilheteria/consultaCadeirasDisponiveis.action?idSessao=<id>` | Lists free seats for a session on sale. |
| `venda-ingresso.sescsp.org.br/eventos/...` | The ticket API behind the app and the Central de Relacionamento. Returns 403 `TOKEN_JWT_INVALIDO` without a login. |

The Credencial Sesc SP app (Android `br.org.sesc.credencialvirtual`, iOS `br.org.sesc.credencial`) is built with React Native and contains the same backend addresses as the web portal. Its traffic while logged in hasn't been inspected, so logged-in users may see data not listed here.

Don't call the write routes in the API index, such as `/wp/v1/upload-csv` or `/wp/v1/destaques`, or the seat-holding and order routes in the box office. If you find a security problem, report it to Sesc rather than probing it.
