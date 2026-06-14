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

    try {
        // 1. LOGIN SED
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
        const cdUsuario9 = loginRes.data.DadosUsuario.CD_USUARIO.toString();
        const cdUsuario8 = cdUsuario9.substring(0, 8);

        console.log(`[BFF] Token Recebido. Iniciando consultas para Aluno: ${cdUsuario8}`);

        // Configuração global de segurança para as chamadas da SED
        const sedConfig = {
            maxRedirects: 0, // CRÍTICO: Impede o Axios de perder o Bearer token em redirecionamentos do APIM Azure
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

        // 2. BUSCAR TURMA
        let infoTurma = {};
        let escolaId = 0;
        try {
            const turmaRes = await axios.get(
                `${CONSTANTS.BASE_SED}/apihubintegracoes/api/v2/Turma/ListarTurmasPorAluno?codigoAluno=${cdUsuario8}`, 
                sedConfig
            );
            infoTurma = Array.isArray(turmaRes.data) ? turmaRes.data[0] : (turmaRes.data.data || {});
            escolaId = infoTurma.CodigoEscola || 0;
        } catch (errTurma) {
            console.error("Erro controlado na rota #3 (Turma):", errTurma.response?.status || errTurma.message);
            // Se o Azure retornou redirect (302) interceptamos a URL destino manualmente
            if (errTurma.response?.status === 302 && errTurma.response.headers.location) {
                const redirectUrl = errTurma.response.headers.location;
                const retryRes = await axios.get(redirectUrl, sedConfig);
                infoTurma = Array.isArray(retryRes.data) ? retryRes.data[0] : (retryRes.data.data || {});
                escolaId = infoTurma.CodigoEscola || 0;
            }
        }

        // 3. HANDSHAKE IP.TV
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

        const authTokenIptv = iptvHandshake.data.auth_token;

        // 4. BUSCAR AVALIAÇÕES
        let totalAvaliacoes = 0;
        try {
            const avalRes = await axios.get(`${CONSTANTS.BASE_SED}/apiboletim/api/Avaliacao/GetAvaliacaoAluno?AlunoId=${cdUsuario8}&AnoLetivo=2026`, sedConfig);
            const listaAvaliacoes = Array.isArray(avalRes.data) ? avalRes.data : (avalRes.data.data || []);
            totalAvaliacoes = listaAvaliacoes.length;
        } catch (errAval) {
            console.error("Erro na rota de avaliações:", errAval.response?.status || errAval.message);
        }

        // 5. BUSCAR TAREFAS NA IP.TV
        let tarefasPendentes = 0;
        let tarefasExpiradas = 0;
        try {
            const tasksRes = await axios.get(`${CONSTANTS.BASE_IPTV}/tms/task/todo/count?filter_expired=true&publication_target=vialv`, {
                httpsAgent,
                headers: { 
                    'x-api-key': authTokenIptv, 
                    'Host': 'edusp',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                }
            });
            tarefasPendentes = tasksRes.data.todo || 0;
            tarefasExpiradas = tasksRes.data.expired || 0;
        } catch (errTasks) {
            console.error("Erro na rota de tarefas IPTV:", errTasks.response?.status || errTasks.message);
        }

        // RETORNO ESTRUTURADO
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
        console.error("Erro Crítico no Fluxo BFF:", error.response ? error.response.status : error.message);
        res.status(error.response ? error.response.status : 500).json({
            error: "Falha na validação de segurança da infraestrutura de dados.",
            details: error.response ? error.response.data : error.message
        });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`BFF com persistência de Header ativa na porta ${PORT}`));
