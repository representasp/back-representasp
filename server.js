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
    BASE_SED: 'https://sedintegracoes.educacao.sp.gov.br/saladofuturobffapi',
    BASE_IPTV: 'https://edusp-api.ip.tv'
};

app.post('/api/consulta', async (req, res) => {
    const { user, senha } = req.body;

    console.log(`\n=== [DEBUG] NOVA REQUISIÇÃO RECEBIDA PARA O RA: ${user} ===`);

    try {
        // ----------------------------------------------------------
        // 1. LOGIN SED
        // ----------------------------------------------------------
        console.log("[DEBUG] [PASSO 1] Tentando Autenticação na SED...");
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
        const cdUsuario9 = loginRes.data.DadosUsuario?.CD_USUARIO?.toString();
        
        if (!tokenSed) {
            console.error("[DEBUG] [ERRO CRÍTICO] Objeto de login bem-sucedido, mas campo 'token' veio vazio!");
            return res.status(401).json({ error: "Token não retornado pela SED." });
        }

        const cdUsuario8 = cdUsuario9 ? cdUsuario9.substring(0, 8) : '';
        console.log(`[DEBUG] Login OK. Aluno 9D: ${cdUsuario9} | Aluno Truncado 8D: ${cdUsuario8}`);
        console.log(`[DEBUG] Tamanho do Token SED Recebido: ${tokenSed.length} caracteres.`);
        console.log(`[DEBUG] Primeiros 30 caracteres do Token: "${tokenSed.substring(0, 30)}..."`);

        // Configuração de Headers Estritos para a SED
        const sedConfig = {
            maxRedirects: 0,
            validateStatus: (status) => status >= 200 && status < 400,
            headers: {
                'Authorization': `Bearer ${tokenSed}`,
                'X-Product-Name': CONSTANTS.PRODUCT,
                'Ocp-Apim-Subscription-Key': CONSTANTS.SUB_KEY,
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/plain, */*',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Origin': 'https://saladofuturo.educacao.sp.gov.br',
                'Referer': 'https://saladofuturo.educacao.sp.gov.br/'
            }
        };

        // ----------------------------------------------------------
        // 2. BUSCAR TURMA
        // ----------------------------------------------------------
        let infoTurma = {};
        let escolaId = 0;
        const urlTurma = `${CONSTANTS.BASE_SED}/apihubintegracoes/api/v2/Turma/ListarTurmasPorAluno?codigoAluno=${cdUsuario8}`;
        console.log(`[DEBUG] [PASSO 2] Chamando rota de Turma: ${urlTurma}`);
        
        try {
            const turmaRes = await axios.get(urlTurma, sedConfig);
            infoTurma = Array.isArray(turmaRes.data) ? turmaRes.data[0] : (turmaRes.data.data || {});
            escolaId = infoTurma.CodigoEscola || 0;
            console.log(`[DEBUG] Sucesso na Rota de Turma! Escola detectada: ${escolaId}`);
        } catch (errTurma) {
            console.error(`[DEBUG] [FALHA ROTA TURMA] Status: ${errTurma.response?.status}`);
            console.error(`[DEBUG] Headers de Resposta do Erro da Turma:`, JSON.stringify(errTurma.response?.headers || {}));
            console.error(`[DEBUG] Corpo do Erro da Turma da SED:`, JSON.stringify(errTurma.response?.data || errTurma.message));
            
            if (errTurma.response?.status === 302 && errTurma.response.headers.location) {
                console.log(`[DEBUG] Detectado redirecionamento 302 para: ${errTurma.response.headers.location}`);
            }
        }

        // ----------------------------------------------------------
        // 3. HANDSHAKE IP.TV
        // ----------------------------------------------------------
        let authTokenIptv = null;
        console.log("[DEBUG] [PASSO 3] Iniciando Handshake com a IP.TV...");
        try {
            const iptvHandshake = await axios.post(`${CONSTANTS.BASE_IPTV}/registration/edusp/token`,
                { token: tokenSed },
                {
                    httpsAgent,
                    headers: {
                        'Host': 'edusp',
                        'x-api-realm': 'edusp',
                        'x-api-platform': 'webclient',
                        'Content-Type': 'application/json',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                    }
                }
            );
            authTokenIptv = iptvHandshake.data?.auth_token;
            console.log(`[DEBUG] Handshake IP.TV efetuado com sucesso! Token gerado: ${authTokenIptv ? 'SIM' : 'NÃO'}`);
        } catch (errIptv) {
            console.error(`[DEBUG] [FALHA HANDSHAKE IP.TV] Status: ${errIptv.response?.status}`);
            console.error(`[DEBUG] Resposta de Erro da IP.TV:`, JSON.stringify(errIptv.response?.data || errIptv.message));
        }

        // ----------------------------------------------------------
        // 4. BUSCAR AVALIAÇÕES
        // ----------------------------------------------------------
        let totalAvaliacoes = 0;
        console.log("[DEBUG] [PASSO 4] Buscando Avaliações na SED...");
        try {
            const avalRes = await axios.get(`${CONSTANTS.BASE_SED}/apiboletim/api/Avaliacao/GetAvaliacaoAluno?AlunoId=${cdUsuario8}&AnoLetivo=2026`, sedConfig);
            const listaAvaliacoes = Array.isArray(avalRes.data) ? avalRes.data : (avalRes.data.data || []);
            totalAvaliacoes = listaAvaliacoes.length;
            console.log(`[DEBUG] Avaliações processadas. Total: ${totalAvaliacoes}`);
        } catch (errAval) {
            console.error(`[DEBUG] [FALHA AVALIAÇÕES] Status: ${errAval.response?.status}. Mensagem: ${errAval.message}`);
        }

        // ----------------------------------------------------------
        // 5. BUSCAR TAREFAS NA IP.TV
        // ----------------------------------------------------------
        let tarefasPendentes = 0;
        let tarefasExpiradas = 0;
        if (authTokenIptv) {
            console.log("[DEBUG] [PASSO 5] Buscando contagem de tarefas na IP.TV...");
            try {
                const tasksRes = await axios.get(`${CONSTANTS.BASE_IPTV}/tms/task/todo/count?filter_expired=true&publication_target=vialv`, {
                    httpsAgent,
                    headers: { 
                        'x-api-key': authTokenIptv, 
                        'Host': 'edusp',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                    }
                });
                tarefasPendentes = tasksRes.data?.todo || 0;
                tarefasExpiradas = tasksRes.data?.expired || 0;
                console.log(`[DEBUG] Tarefas lidas da IP.TV -> Pendentes: ${tarefasPendentes} | Expiradas: ${tarefasExpiradas}`);
            } catch (errTasks) {
                console.error(`[DEBUG] [FALHA CONTAGEM TAREFAS] Status: ${errTasks.response?.status}. Mensagem: ${errTasks.message}`);
            }
        } else {
            console.log("[DEBUG] [PASSO 5] Ignorado: Sem Token IP.TV ativo.");
        }

        // Retorno padrão estruturado para não quebrar o dashboard
        res.json({
            aluno: {
                codigo: cdUsuario8,
                escola: infoTurma.NomeEscola || 'Não Informada',
                turma: infoTurma.DescricaoTurma || 'Não Informada'
            },
            indicadores: {
                pendentes: tarefasPendentes,
                expiradas: tarefasExpiradas,
                avaliacoes: totalAvaliacoes,
                redacoes: 0
            }
        });

    } catch (error) {
        console.error(`\n[DEBUG] [ERRO CRÍTICO NO BARRAMENTO PRINCIPAL]`);
        console.error(`Mensagem: ${error.message}`);
        if (error.response) {
            console.error(`Status HTTP: ${error.response.status}`);
            console.error(`Dados retornados do erro global:`, JSON.stringify(error.response.data));
        }
        
        res.status(error.response ? error.response.status : 500).json({
            error: "Falha interna no barramento sob rastreamento.",
            details: error.message
        });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`BFF em modo Monitoramento Ativo rodando na porta ${PORT}`));
