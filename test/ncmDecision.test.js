// AutoBack/test/ncmDecision.test.js
//
// Testes de regressao da parte "congelada" do classificador: as regras puras
// de AutoBack/fiscal/ncmDecision.js. Rodam offline, sem banco de dados e sem
// chamada de IA (node --test). Nao cobrem se a IA "acerta" o NCM de um produto
// de verdade - isso depende de busca web ao vivo e pode variar; o que fica
// travado aqui e o comportamento de aceitar/rejeitar/aplicar o que a IA volta.
//
// Rodar com: npm test (ou node --test test/)

import test from "node:test";
import assert from "node:assert/strict";
import {
  decideNcmValidity,
  decideNcmStatusAndWarnings,
  decideSafeToApplyNcm,
  decideFieldsEligibleToApply,
  decideIcmsRegimeFields
} from "../fiscal/ncmDecision.js";

test("decideNcmValidity aceita NCM de 8 digitos, com ou sem pontuacao", () => {
  assert.equal(decideNcmValidity("85395200").acceptedNcm, true);
  assert.equal(decideNcmValidity("8539.52.00").aiReturnedNcm, "85395200");
  assert.equal(decideNcmValidity("10063029").acceptedNcm, true);
});

test("decideNcmValidity rejeita NCM com menos ou mais de 8 digitos", () => {
  const curto = decideNcmValidity("853952");
  assert.equal(curto.acceptedNcm, false);
  assert.equal(curto.invalidReturnedNcm, true);

  const longo = decideNcmValidity("853952001");
  assert.equal(longo.acceptedNcm, false);
  assert.equal(longo.invalidReturnedNcm, true);
});

test("decideNcmValidity trata NCM vazio ou 00000000 como 'sem retorno', nao como invalido", () => {
  const vazio = decideNcmValidity("");
  assert.equal(vazio.acceptedNcm, false);
  assert.equal(vazio.invalidReturnedNcm, false, "vazio nao e a mesma coisa que malformado");

  const zerado = decideNcmValidity("00000000");
  assert.equal(zerado.acceptedNcm, false);
  assert.equal(zerado.invalidReturnedNcm, false);
});

test("decideNcmStatusAndWarnings: NCM valido + identidade ok + achou na base oficial => CLASSIFICADO sem avisos extras", () => {
  const { status, warnings } = decideNcmStatusAndWarnings({
    aiStatus: "CLASSIFICADO",
    identityOk: true,
    identityErrors: [],
    invalidReturnedNcm: false,
    rawNcmValue: "85395200",
    acceptedNcm: true,
    outputNcm: "85395200",
    officialExists: true,
    aiReturnedNcm: "85395200",
    baseWarnings: []
  });
  assert.equal(status, "CLASSIFICADO");
  assert.deepEqual(warnings, []);
});

test("decideNcmStatusAndWarnings: NCM valido mas identidade (request_id/sku) divergente => continua CLASSIFICADO, so vira aviso", () => {
  const { status, warnings } = decideNcmStatusAndWarnings({
    aiStatus: "CLASSIFICADO",
    identityOk: false,
    identityErrors: ["request_id divergente: esperado req_1, recebido req_2."],
    invalidReturnedNcm: false,
    rawNcmValue: "85395200",
    acceptedNcm: true,
    outputNcm: "85395200",
    officialExists: true,
    aiReturnedNcm: "85395200",
    baseWarnings: []
  });
  assert.equal(status, "CLASSIFICADO", "divergencia de identidade nao deve mais bloquear a resposta");
  assert.ok(warnings.some((w) => w.includes("request_id divergente")));
});

test("decideNcmStatusAndWarnings: NCM com digitos invalidos => ERRO_VALIDACAO", () => {
  const { status, warnings } = decideNcmStatusAndWarnings({
    aiStatus: "CLASSIFICADO",
    identityOk: true,
    identityErrors: [],
    invalidReturnedNcm: true,
    rawNcmValue: "853952",
    acceptedNcm: false,
    outputNcm: "00000000",
    officialExists: false,
    aiReturnedNcm: "",
    baseWarnings: []
  });
  assert.equal(status, "ERRO_VALIDACAO");
  assert.ok(warnings.some((w) => w.includes("NCM retornado invalido")));
});

test("decideNcmStatusAndWarnings: NCM valido mas fora da tabela oficial local => ainda CLASSIFICADO, com aviso", () => {
  const { status, warnings } = decideNcmStatusAndWarnings({
    aiStatus: "CLASSIFICADO",
    identityOk: true,
    identityErrors: [],
    invalidReturnedNcm: false,
    rawNcmValue: "76151000",
    acceptedNcm: true,
    outputNcm: "76151000",
    officialExists: false,
    aiReturnedNcm: "76151000",
    baseWarnings: []
  });
  assert.equal(status, "CLASSIFICADO");
  assert.ok(warnings.some((w) => w.includes("nao localizado na base NCM oficial local")));
});

test("decideSafeToApplyNcm: so libera sobrescrever o NCM quando CLASSIFICADO + aceito", () => {
  assert.equal(decideSafeToApplyNcm("CLASSIFICADO", true), true);
  assert.equal(decideSafeToApplyNcm("CLASSIFICADO", false), false);
  assert.equal(decideSafeToApplyNcm("ERRO_VALIDACAO", true), false);
  assert.equal(decideSafeToApplyNcm("REVISAO_MANUAL", true), false);
});

test("decideFieldsEligibleToApply: aplica os demais campos fiscais pra qualquer status, menos falha total da OpenAI", () => {
  assert.equal(decideFieldsEligibleToApply("CLASSIFICADO"), true);
  assert.equal(decideFieldsEligibleToApply("ERRO_VALIDACAO"), true, "NCM invalido nao deve mais bloquear CEST/CFOP/PIS/COFINS/etc");
  assert.equal(decideFieldsEligibleToApply("REVISAO_MANUAL"), true);
  assert.equal(decideFieldsEligibleToApply("ERRO_OPENAI"), false, "sem resposta de verdade da IA, nao ha o que aplicar");
});

test("decideIcmsRegimeFields: Simples Nacional sempre usa CSOSN, nunca CST ICMS", () => {
  const result = decideIcmsRegimeFields({
    regimeTributario: "simples_nacional",
    suggestedCstIcms: "060",
    suggestedCsosn: "500"
  });
  assert.equal(result.cst_icms, null);
  assert.equal(result.csosn, "500");
});

test("decideIcmsRegimeFields: regime normal (Lucro Real/Presumido) sempre usa CST ICMS, nunca CSOSN", () => {
  const result = decideIcmsRegimeFields({
    regimeTributario: "lucro_presumido",
    suggestedCstIcms: "060",
    suggestedCsosn: "500"
  });
  assert.equal(result.cst_icms, "060");
  assert.equal(result.csosn, null);
});

test("decideIcmsRegimeFields: reconhece 'Simples Nacional' com acentos/maiusculas/espacos como o mesmo regime", () => {
  const result = decideIcmsRegimeFields({
    regimeTributario: "Simples Nacional",
    suggestedCstIcms: "060",
    suggestedCsosn: "500"
  });
  assert.equal(result.cst_icms, null);
  assert.equal(result.csosn, "500");
});
