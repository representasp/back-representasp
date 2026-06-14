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

    console.log(`\n=== [BFF PRODUÇÃO] PROCESSANDO INTEGRAÇÃO PARA: ${user} ===`);

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
        const dadosUsuario = loginRes.data.DadosUsuario || {};
        const cdUsuario9 = dadosUsuario.CD_USUARIO?.toString();
        const cdUsuario8 = cdUsuario9 ? cdUsuario9.substring(0, 8) : '';
        const nomeCompletoAluno = dadosUsuario.NAME || 'Estudante';
        const nickAluno = dadosUsuario.NM_NICK || '';

        // Captura e isolamento de cookies do Azure Application Gateway
        const cookiesRecebidos = loginRes.headers['set-cookie'] || [];
        const cookiesFiltrados = cookiesRecebidos.map(cookie => cookie.split(';')[0]).join('; ');

        // Configuração padrão reutilizável para chamadas da SED
        const sedConfig = {
            headers: {
                'Authorization': `Bearer ${tokenSed}`,
                'X-Product-Name': CONSTANTS.PRODUCT,
                'Ocp-Apim-Subscription-Key': CONSTANTS.SUB_KEY,
                'Cookie': cookiesFiltrados,
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/plain, */*',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Origin': 'https://saladofuturo.educacao.sp.gov.br',
                'Referer': 'https://saladofuturo.educacao.sp.gov.br/'
            }
        };

        // ----------------------------------------------------------
        // 2. BUSCAR TURMA (SED)
        // ----------------------------------------------------------
        let infoTurma = {};
        try {
            const turmaRes = await axios.get(
                `${CONSTANTS.BASE_SED}/apihubintegracoes/api/v2/Turma/ListarTurmasPorAluno?codigoAluno=${cdUsuario8}`, 
                sedConfig
            );
            if (Array.isArray(turmaRes.data)) {
                infoTurma = turmaRes.data[0];
            } else if (turmaRes.data?.data) {
                infoTurma = Array.isArray(turmaRes.data.data) ? turmaRes.data.data[0] : turmaRes.data.data;
            }
        } catch (errTurma) {
            console.error(`[BFF] Erro na rota de Turma: ${errTurma.message}`);
        }

        // ----------------------------------------------------------
        // 3. HANDSHAKE IP.TV
        // ----------------------------------------------------------
        let authTokenIptv = null;
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
        } catch (errIptv) {
            console.error(`[BFF] Erro no Handshake IPTV: ${errIptv.message}`);
        }

        // ----------------------------------------------------------
        // 4. BUSCAR AVALIAÇÕES (SED - Dinâmico por AlunoId)
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
        // 5. FLUXO DINÂMICO DE TAREFAS E REDAÇÕES (IP.TV)
        // ----------------------------------------------------------
        let tarefasPendentes = 0;
        let tarefasExpiradas = 0;
        let totalRedacoes = 0;

        if (authTokenIptv) {
            try {
                // PASSO A: Descobrir as salas (rooms) e categorias do aluno
                const configIptvBase = {
                    httpsAgent,
                    headers: { 
                        'x-api-key': authTokenIptv, 
                        'Host': 'edusp',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                    }
                };

                const roomsRes = await axios.get(`${CONSTANTS.BASE_IPTV}/room/user?list_all=true&with_cards=true`, configIptvBase);
                const rooms = roomsRes.data?.rooms || [];
                
                // Construção dinâmica da query de alvos exigida pelo gateway da CMSP/IP.TV
                const targets = [];
                rooms.forEach(r => {
                    if (r.name) {
                        targets.push(`publication_target=${r.name}`);
                        if (nickAluno) {
                            targets.push(`publication_target=${r.name}:${nickAluno}-sp`);
                        }
                    }
                    if (Array.isArray(r.category_ids)) {
                        r.category_ids.forEach(id => targets.push(`publication_target=${id}`));
                    }
                });

                const targetQuery = targets.length > 0 ? targets.join('&') : 'publication_target=all';

                // PASSO B: Buscar Tarefas Pendentes
                try {
                    const urlPendentes = `${CONSTANTS.BASE_IPTV}/tms/task/todo?${targetQuery}&filter_expired=true&with_answer=true&answer_statuses=draft&answer_statuses=pending`;
                    const pendentesRes = await axios.get(urlPendentes, configIptvBase);
                    const listaPendentes = Array.isArray(pendentesRes.data) ? pendentesRes.data : (pendentesRes.data?.data || []);
                    tarefasPendentes = listaPendentes.length;
                } catch (ePend) { console.error(`[BFF] Falha ao ler pendentes: ${ePend.message}`); }

                // PASSO C: Buscar Tarefas Expiradas
                try {
                    const urlExpiradas = `${CONSTANTS.BASE_IPTV}/tms/task/todo?${targetQuery}&expired_only=true&filter_expired=false&with_answer=true`;
                    const expiradasRes = await axios.get(urlExpiradas, configIptvBase);
                    const listaExpiradas = Array.isArray(expiradasRes.data) ? expiradasRes.data : (expiradasRes.data?.data || []);
                    tarefasExpiradas = listaExpiradas.length;
                } catch (eExp) { console.error(`[BFF] Falha ao ler expiradas: ${eExp.message}`); }

                // PASSO D: Buscar Redações (Flag is_essay=true)
                try {
                    const urlRedacoes = `${CONSTANTS.BASE_IPTV}/tms/task/todo?${targetQuery}&is_essay=true&filter_expired=true&with_answer=true`;
                    const redacoesRes = await axios.get(urlRedacoes, configIptvBase);
                    const listaRedacoes = Array.isArray(redacoesRes.data) ? redacoesRes.data : (redacoesRes.data?.data || []);
                    totalRedacoes = listaRedacoes.length;
                } catch (eRed) { console.error(`[BFF] Falha ao ler redações: ${eRed.message}`); }

            } catch (errRooms) {
                console.error(`[BFF] Erro na varredura estrutural da IP.TV: ${errRooms.message}`);
            }
        }

        // RESPOSTA FINAL COMPATÍVEL COM O SEU DASHBOARD
        res.json({
            aluno: {
                nome: nomeCompletoAluno,
                codigo: `${cdUsuario8}${user.slice(-3)}`, // Retorna o RA no formato completo original
                escola: infoTurma.NomeEscola || 'Não Informada',
                turma: infoTurma.DescricaoTurma || 'Não Informada'
            },
            indicadores: {
                pendentes: tarefasPendentes,
                expiradas: tarefasExpiradas,
                avaliacoes: totalAvaliacoes,
                redacoes: totalRedacoes
            }
        });

    } catch (error) {
        console.error(`[BFF] Erro Crítico Geral: ${error.message}`);
        res.status(error.response ? error.response.status : 500).json({
            error: "Falha de comunicação no barramento dinâmico.",
            details: error.message
        });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`BFF Relatório de Salas e Metas ativo na porta ${PORT}`));
