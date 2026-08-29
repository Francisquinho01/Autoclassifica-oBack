// AutoBack/fiscal/ncmDecision.js
//
// Regras puras de decisao do classificador fiscal: nada aqui acessa banco de
// dados, rede ou tem qualquer efeito colateral. Foram extraidas de dentro de
// `normalizeAiNcmResult` (server.js) de proposito, pra poderem ser testadas
// sozinhas em AutoBack/test/ncmDecision.test.js sem precisar rodar o servidor
// nem gastar chamada de IA - e pra qualquer mudanca futura no motor tributario
// (CEST/ICMS/PIS-COFINS/IBS-CBS) nao arriscar quebrar essa parte sem a gente
// perceber. O comportamento aqui deve ficar igual ao que já está em producao;
// mudar isso exige atualizar os testes junto, de proposito.

/**
 * Mesma normalizacao de texto usada no resto do backend (server.js), duplicada
 * aqui para nao criar dependencia cruzada entre o servidor e este modulo puro.
 */
export function normalizeText(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b\d+([,.]\d+)?\s?(kg|g|mg|l|lt|ml|un|und|pct|pc|cx|m|cm|mm)\b/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Reduz qualquer valor aos digitos (remove pontos, tracos, espacos, letras). */
export function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

/**
 * Decide se o NCM retornado pela IA e valido pra ser gravado no produto.
 * Regra: precisa reduzir a exatamente 8 digitos e nao pode ser "00000000".
 * Um valor com digitos mas fora desse formato (ex: 6 digitos) e considerado
 * invalido (nao confundir com "vazio", que so significa "sem retorno").
 */
export function decideNcmValidity(rawNcmValue) {
  const rawNcmDigits = onlyDigits(rawNcmValue);
  const aiReturnedNcm = rawNcmDigits.length === 8 && rawNcmDigits !== "00000000" ? rawNcmDigits : "";
  const invalidReturnedNcm = Boolean(rawNcmValue && rawNcmDigits.length !== 8);
  const validNcm = Boolean(aiReturnedNcm);
  // A resposta da pesquisa web e tratada como fonte de verdade do produto: uma
  // divergencia de request_id/sku (checagem administrativa de sanidade) nao
  // entra aqui - isso e avaliado a parte em decideNcmStatusAndWarnings.
  const acceptedNcm = Boolean(validNcm && !invalidReturnedNcm);
  return { rawNcmDigits, aiReturnedNcm, invalidReturnedNcm, validNcm, acceptedNcm };
}

/**
 * Deriva o status final (CLASSIFICADO / ERRO_VALIDACAO / ...) e a lista de
 * avisos a partir do resultado da validacao de identidade (request_id/sku) e
 * do NCM. Uma divergencia de identidade vira aviso, nao mais erro bloqueante:
 * o que a pesquisa web encontrou pra este produto continua sendo aplicado.
 */
export function decideNcmStatusAndWarnings({
  aiStatus,
  identityOk,
  identityErrors = [],
  invalidReturnedNcm,
  rawNcmValue,
  acceptedNcm,
  outputNcm,
  officialExists,
  aiReturnedNcm,
  baseWarnings = []
}) {
  const warnings = [...baseWarnings];
  const pushUnique = (message) => {
    if (!warnings.some((warning) => normalizeText(warning) === normalizeText(message))) warnings.unshift(message);
  };

  if (!identityOk) {
    warnings.unshift(...identityErrors);
  }

  let status = aiStatus;

  if (invalidReturnedNcm) {
    status = "ERRO_VALIDACAO";
    warnings.unshift(`NCM retornado invalido: ${rawNcmValue || "vazio"}.`);
  } else if (acceptedNcm && !officialExists) {
    pushUnique(`NCM ${outputNcm} aplicado pela pesquisa web, mas nao localizado na base NCM oficial local.`);
    if (!["ERRO_BASE_FISCAL", "ERRO_OPENAI", "ERRO_VALIDACAO"].includes(status)) status = "CLASSIFICADO";
  } else if (acceptedNcm && !["ERRO_BASE_FISCAL", "ERRO_OPENAI", "ERRO_VALIDACAO"].includes(status)) {
    status = "CLASSIFICADO";
  }

  if (!acceptedNcm && aiReturnedNcm && !invalidReturnedNcm) {
    pushUnique(`NCM ${aiReturnedNcm} nao foi aplicado por falha de validacao do contexto.`);
  }

  return { status, warnings };
}

/**
 * So e seguro sobrescrever o NCM do produto quando o status final ficou
 * CLASSIFICADO e o NCM em si foi aceito (8 digitos validos).
 */
export function decideSafeToApplyNcm(status, acceptedNcm) {
  return Boolean(status === "CLASSIFICADO" && acceptedNcm);
}

/**
 * Os demais campos fiscais (CEST, CFOP, CST/aliquotas ICMS-PIS-COFINS-IPI,
 * IBS/CBS, cBenef, vTotTrib...) sao gravados sempre que a chamada tiver de
 * fato respondido (nao falhou direto na OpenAI) - mesmo quando o NCM ainda
 * fica pendente de revisao manual. Isso e o oposto do gate antigo, que
 * derrubava tudo junto quando o NCM nao validava.
 */
export function decideFieldsEligibleToApply(status) {
  return Boolean(status !== "ERRO_OPENAI");
}

/**
 * CSOSN e CST ICMS sao mutuamente exclusivos no layout da NF-e (Manual de
 * Orientacao do Contribuinte, grupos N11/N12): quem e optante do Simples
 * Nacional sempre usa CSOSN e nunca CST ICMS, e vice-versa pra quem nao e.
 * Essa e uma regra estrutural do documento fiscal, nao uma alicota que possa
 * variar por produto - por isso e decidida aqui pelo regime da empresa, sem
 * depender da IA lembrar disso a cada produto.
 */
export function decideIcmsRegimeFields({ regimeTributario, suggestedCstIcms, suggestedCsosn }) {
  const isSimplesNacional = normalizeText(regimeTributario) === "simples nacional";
  if (isSimplesNacional) {
    return { cst_icms: null, csosn: suggestedCsosn || null };
  }
  return { cst_icms: suggestedCstIcms || null, csosn: null };
}
