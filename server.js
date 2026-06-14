const express = require('express');
const axios = require('axios');
const https = require('https');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const CONSTANTS = {
    SUB_KEY: 'd701a2043aa24d7ebb37e9adf60d043b',
    PRODUCT: 'SalaDoFuturo',
    BASE_SED: 'https://sedintegracoes.educacao.sp.gov.br/saladofuturobffapi'
};

app.post('/api/consulta', async (req, res) => {
    const { user, senha } = req.body;

    console.log(`\n==================================================`);
    console.log(`[DIAGNÓSTICO] INICIANDO VARREDURA PARA O RA: ${user}`);
    console.log(`==================================================`);

    try {
        // ----------------------------------------------------------
        // STEP 1: AUTENTICAÇÃO NA SED
        // ----------------------------------------------------------
        console.log(`[DIAGNÓSTICO] 1. Tentando LoginCompletoToken...`);
        const loginRes = await axios.post(`${CONSTANTS.BASE_SED}/credenciais/api/LoginCompletoToken`,
            { user, senha },
            { headers: {
                'Content-Type': 'application/json',
                'X-Product-Name': CONSTANTS.PRODUCT,
                'Ocp-Apim-Subscription-Key': CONSTANTS.SUB_KEY,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }}
        );

        const tokenSed = loginRes.data.token;
        console.log(`[DIAGNÓSTICO] Token SED obtido com sucesso (Tamanho: ${tokenSed?.length ?? 0})`);

        // ----------------------------------------------------------
        // STEP 2: MARATONA DE TESTES ENDPOINTS IPTV (PROCURANDO ROTAS DO LOG)
        // ----------------------------------------------------------
        console.log(`\n[DIAGNÓSTICO] 2. Iniciando testes de Handshake IPTV...`);
        
        const cenariosIptv = [
            {
                nome: "Cenário A: edusp-api com Host edusp (Padrão do App)",
                url: "https://edusp-api.ip.tv/registration/edusp/token",
                headers: { 'Host': 'edusp', 'x-api-realm': 'edusp', 'x-api-platform': 'webclient' }
            },
            {
                nome: "Cenário B: edusp-api sem Host modificado",
                url: "https://edusp-api.ip.tv/registration/edusp/token",
                headers: { 'x-api-realm': 'edusp', 'x-api-platform': 'webclient' }
            },
            {
                nome: "Cenário C: Rota de Contingência Direta da SED",
                url: `${CONSTANTS.BASE_SED}/apihubintegracoes/api/v2/IPTV/Token`, // Rota espelho comum em BFFs da SED
                headers: { 'Authorization': `Bearer ${tokenSed}`, 'X-Product-Name': CONSTANTS.PRODUCT, 'Ocp-Apim-Subscription-Key': CONSTANTS.SUB_KEY }
            }
        ];

        let resultadoHandshake = null;

        for (const cenario of cenariosIptv) {
            console.log(`\nExecutando: ${cenario.nome}`);
            console.log(`URL: ${cenario.url}`);
            try {
                const response = await axios.post(cenario.url, 
                    cenario.url.includes('token') ? { token: tokenSed } : {}, 
                    { 
                        httpsAgent, 
                        headers: {
                            ...cenario.headers,
                            'Content-Type': 'application/json',
                            'User-Agent': 'Mozilla/5.0'
                        },
                        timeout: 5000 
                    }
                );
                console.log(`🟢 SUCESSO no ${cenario.nome}! Status: ${response.status}`);
                console.log(`Payload Recebido:`, JSON.stringify(response.data));
                if (response.data?.auth_token || response.data?.token) {
                    resultadoHandshake = response.data?.auth_token || response.data?.token;
                }
            } catch (err) {
                console.error(`🔴 FALHA no ${cenario.nome}`);
                console.error(`Status: ${err.response?.status || 'Sem Resposta'}`);
                console.error(`Mensagem de Erro: ${err.message}`);
                if (err.response?.data) {
                    console.error(`Corpo do erro do servidor do governo:`, JSON.stringify(err.response.data));
                }
            }
        }

        // ----------------------------------------------------------
        // RETORNO PADRÃO DE CONTINGÊNCIA PARA O FRONT NÃO TRAVAR
        // ----------------------------------------------------------
        res.json({
            diagnostico: "Varredura executada. Verifique os logs do Render imediatamente para copiar os erros brutos.",
            tokenIptvEncontrado: resultadoHandshake ? "Sim" : "Não",
            aluno: loginRes.data.DadosUsuario?.NAME || "Estudante"
        });

    } catch (error) {
        console.error(`\n[DIAGNÓSTICO ERRO CRÍTICO NO PASSO 1]: ${error.message}`);
        res.status(500).json({ error: error.message, stack: error.stack });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`BFF de Diagnóstico Ativo na porta ${PORT}`));
