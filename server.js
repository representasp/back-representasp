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

    console.log(`\n=== [PRODUÇÃO] REQUISIÇÃO RECEBIDA PARA O RA: ${user} ===`);

    try {
        // ----------------------------------------------------------
        // 1. LOGIN SED
        // ----------------------------------------------------------
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
        const cdUsuario8 = cdUsuario9 ? cdUsuario9.substring(0, 8) : '';

        // CAPTURA DOS COOKIES DE AFINIDADE DO GATEWAY AZURE (Resolve o 401)
        const cookiesRecebidos = loginRes.headers['set-cookie'] || [];
        const cookiesFiltrados = cookiesRecebidos.map(cookie => cookie.split(';')[0]).join('; ');

        console.log(`[BFF] Cookies de afinidade mapeados com sucesso.`);

        // Configuração de Headers com Injeção de Cookies e Token Estrito
        const sedConfig = {
            headers: {
                'Authorization': `Bearer ${tokenSed}`,
                'X-Product-Name': CONSTANTS.PRODUCT,
                'Ocp-Apim-Subscription-Key': CONSTANTS.SUB_KEY,
                'Cookie': cookiesFiltrados, // Envia de volta a afinidade exigida pelo Azure
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/plain, */*',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Origin': 'https://saladofuturo.educacao.sp.gov.br',
                'Referer': 'https://saladofuturo.educacao.sp.gov.br/'
            }
        };

        // ----------------------------------------------------------
        // 2. BUSCAR TURMA (Usando Cookies de Afinidade)
        // ----------------------------------------------------------
        let infoTurma = {};
        let escolaId = 0;
        try {
            const turmaRes = await axios.get(
                `${CONSTANTS.BASE_SED}/apihubintegracoes/api/v2/Turma/ListarTurmasPorAluno?codigoAluno=${cdUsuario8}`, 
                sedConfig
            );
            infoTurma = Array.isArray(turmaRes.data) ? turmaRes.data[0] : (turmaRes.data.data || {});
            escolaId = infoTurma.CodigoEscola || 0;
            console.log(`[BFF] Rota de Turma Sucesso! Escola: ${escolaId}`);
        } catch (errTurma) {
            console.error(`[BFF] Erro na rota de Turma mesmo com afinidade: ${errTurma.message}`);
        }

        // ----------------------------------------------------------
        // 3. HANDSHAKE IP.TV (Ajuste de Rota)
        // ----------------------------------------------------------
        let authTokenIptv = null;
        try {
            const iptvHandshake = await axios.post(`${CONSTANTS.BASE_IPTV}/registration/edusp/token`,
                { token: tokenSed },
                {
                    httpsAgent,
                    headers: {
                        'Host': 'edusp-api.ip.tv', // Alinhado com o Nginx reverso
                        'x-api-realm': 'edusp',
                        'x-api-platform': 'webclient',
                        'Content-Type': 'application/json',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                    }
                }
            );
            authTokenIptv = iptvHandshake.data?.auth_token;
        } catch (errIptv) {
            // Fallback de contingência caso o Nginx exija Host reduzido
            try {
                const iptvRetry = await axios.post(`${CONSTANTS.BASE_IPTV}/registration/edusp/token`,
                    { token: tokenSed },
                    {
                        httpsAgent,
                        headers: {
                            'Host': 'edusp',
                            'x-api-realm': 'edusp',
                            'x-api-platform': 'webclient',
                            'Content-Type': 'application/json'
                        }
                    }
                );
                authTokenIptv = iptvRetry.data?.auth_token;
            } catch (e) {
                console.error(`[BFF] Falha total no Handshake IPTV: ${e.message}`);
            }
        }

        // ----------------------------------------------------------
        // 4. BUSCAR AVALIAÇÕES (Usando Cookies de Afinidade)
        // ----------------------------------------------------------
        let totalAvaliacoes = 0;
        try {
            const avalRes = await axios.get(`${CONSTANTS.BASE_SED}/apiboletim/api/Avaliacao/GetAvaliacaoAluno?AlunoId=${cdUsuario8}&AnoLetivo=2026`, sedConfig);
            const listaAvaliacoes = Array.isArray(avalRes.data) ? avalRes.data : (avalRes.data.data || []);
            totalAvaliacoes = listaAvaliacoes.length;
        } catch (errAval) {
            console.error(`[BFF] Erro na rota de avaliações: ${errAval.message}`);
        }

        // ----------------------------------------------------------
        // 5. BUSCAR TAREFAS NA IP.TV
        // ----------------------------------------------------------
        let tarefasPendentes = 0;
        let tarefasExpiradas = 0;
        if (authTokenIptv) {
            try {
                const tasksRes = await axios.get(`${CONSTANTS.BASE_IPTV}/tms/task/todo/count?filter_expired=true&publication_target=vialv`, {
                    httpsAgent,
                    headers: { 
                        'x-api-key': authTokenIptv, 
                        'Host': 'edusp-api.ip.tv',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                    }
                });
                tarefasPendentes = tasksRes.data?.todo || 0;
                tarefasExpiradas = tasksRes.data?.expired || 0;
            } catch (errTasks) {
                console.error(`[BFF] Erro na busca de tarefas IP.TV: ${errTasks.message}`);
            }
        }

        // Resposta consolidada limpa
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
        console.error(`[BFF] Erro Geral: ${error.message}`);
        res.status(error.response ? error.response.status : 500).json({
            error: "Falha na consolidação de dados governamentais estruturados.",
            details: error.message
        });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`BFF com Gerenciador de Afinidade Ativo na porta ${PORT}`));
