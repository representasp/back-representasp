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

    console.log(`\n======================================================`);
    console.log(`🚀 [BFF SUPER LOGS ACTIVE] INICIANDO REQUISIÇÃO: ${user}`);
    console.log(`======================================================`);

    try {
        // ----------------------------------------------------------
        // 1. AUTENTICAÇÃO CENTRALIZADA (SED)
        // ----------------------------------------------------------
        const loginRes = await axios.post(`${CONSTANTS.BASE_SED}/credenciais/api/LoginCompletoToken`,
            { user, senha },
            { headers: {
                'Content-Type': 'application/json',
                'X-Product-Name': CONSTANTS.PRODUCT,
                'Ocp-Apim-Subscription-Key': CONSTANTS.SUB_KEY,
                'User-Agent': 'Mozilla/5.0'
            }}
        );

        const tokenSed = loginRes.data.token;
        const dadosUsuario = loginRes.data.DadosUsuario || {};
        const cdUsuario9 = dadosUsuario.CD_USUARIO?.toString();
        const cdUsuario8 = cdUsuario9 ? cdUsuario9.substring(0, 8) : '';
        const nomeCompletoAluno = dadosUsuario.NAME || 'Estudante';
        const raCompletoFormatado = `${cdUsuario8}${user.slice(-3)}`.toUpperCase();
        
        // Regra Oculta do Nick: Forçar estritamente em minúsculas [Log 8]
        const nickClean = dadosUsuario.LOGIN ? dadosUsuario.LOGIN.toLowerCase() : ''; 

        const cookiesRecebidos = loginRes.headers['set-cookie'] || [];
        const cookiesFiltrados = cookiesRecebidos.map(cookie => cookie.split(';')[0]).join('; ');

        const sedConfig = {
            headers: {
                'Authorization': `Bearer ${tokenSed}`,
                'X-Product-Name': CONSTANTS.PRODUCT,
                'Ocp-Apim-Subscription-Key': CONSTANTS.SUB_KEY,
                'Cookie': cookiesFiltrados,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0'
            }
        };

        // ----------------------------------------------------------
        // 2. EXTRAÇÃO DA DATA DE INÍCIO DO BIMESTRE (SED)
        // ----------------------------------------------------------
        let infoTurma = {};
        let schoolId = null;
        try {
            const turmaRes = await axios.get(
                `${CONSTANTS.BASE_SED}/apihubintegracoes/api/v2/Turma/ListarTurmasPorAluno?codigoAluno=${cdUsuario8}`, 
                sedConfig
            );
            if (Array.isArray(turmaRes.data) && turmaRes.data.length > 0) infoTurma = turmaRes.data[0];
            else if (turmaRes.data?.data) infoTurma = Array.isArray(turmaRes.data.data) ? turmaRes.data.data[0] : turmaRes.data.data;
            schoolId = infoTurma?.CodigoEscola || infoTurma?.CD_ESCOLA;
        } catch (err) { console.error(`[BFF] Erro ao buscar turma: ${err.message}`); }

        let dataInicioBimestre = new Date("2026-04-23T00:00:00Z"); 
        if (schoolId) {
            try {
                const bimestreRes = await axios.get(`${CONSTANTS.BASE_SED}/apihubintegracoes/api/v2/Bimestre/ListarBimestres?escolaId=${schoolId}`, sedConfig);
                const listaBimestres = bimestreRes.data?.data || bimestreRes.data || [];
                if (Array.isArray(listaBimestres)) {
                    const bAtivo = listaBimestres.find(b => b.Ativo === true || b.NumeroBimestre === 2);
                    if (bAtivo?.DataInicio) {
                        dataInicioBimestre = new Date(bAtivo.DataInicio);
                    }
                }
            } catch (errBim) { console.error(`[BFF] Erro ao buscar calendário: ${errBim.message}`); }
        }

        // ----------------------------------------------------------
        // 3. HANDSHAKE IP.TV (CONQUISTA DE CREDENCIAIS)
        // ----------------------------------------------------------
        let authTokenIptv = null;
        try {
            const iptvHandshake = await axios.post(`${CONSTANTS.BASE_IPTV}/registration/edusp/token`,
                { token: tokenSed },
                { httpsAgent, headers: { 'x-api-realm': 'edusp', 'x-api-platform': 'webclient', 'Content-Type': 'application/json' }}
            );
            authTokenIptv = iptvHandshake.data?.auth_token;
        } catch (err) { console.error(`[BFF] Erro Handshake IP.TV: ${err.message}`); }

        // ----------------------------------------------------------
        // 4. EXTRAÇÃO DE SALAS E PROCESSAMENTO DA ESTRUTURA CRONOLÓGICA
        // ----------------------------------------------------------
        let pendentes = 0;
        let expiradas = 0;
        let avaliacoes = 0;
        let redacoes = 0;

        if (authTokenIptv) {
            // Configuração base de cabeçalhos obrigatórios do Virtual Host
            const configIptvBase = {
                httpsAgent,
                headers: { 
                    'x-api-key': authTokenIptv, 
                    'Host': 'edusp',
                    'x-api-realm': 'edusp',
                    'x-api-platform': 'webclient',
                    'Accept': 'application/json',
                    'User-Agent': 'Mozilla/5.0'
                }
            };

            // Puxar salas para alimentar os geradores ordenados
            const roomsRes = await axios.get(`${CONSTANTS.BASE_IPTV}/room/user?list_all=true&with_cards=true`, configIptvBase);
            const rooms = roomsRes.data?.rooms || [];
            const allCategories = [...new Set(rooms.flatMap(r => r.category_ids || []))];

            // --- MONTAGEM DA QUERY DE PESQUISAS (Targets no INÍCIO com ?&) [Log 57] ---
            const surveyTargets = [];
            rooms.forEach(r => {
                if (r.name) {
                    surveyTargets.push(`publication_target=${encodeURIComponent(r.name)}`);
                    if (nickClean) {
                        // %3A Codificado obrigatoriamente para as Pesquisas
                        surveyTargets.push(`publication_target=${encodeURIComponent(r.name)}%3A${nickClean}-sp`);
                    }
                }
            });
            allCategories.forEach(id => {
                if (id) surveyTargets.push(`publication_target=${id}`);
            });
            const urlSurvey = `${CONSTANTS.BASE_IPTV}/survey/todo/count?&${surveyTargets.join('&')}&filter_expired=true&with_answer=true&answer_statuses=draft`;


            // --- MONTAGEM DA QUERY DE TAREFAS PENDENTES (Targets no MEIO com ?) [Log 120] ---
            const tmsFixedStartPendentes = "expired_only=false&limit=100&offset=0&filter_expired=true&is_exam=false&with_answer=true&is_essay=false";
            const tmsTargetsPendentes = [];
            rooms.forEach(r => {
                if (r.name) {
                    tmsTargetsPendentes.push(`publication_target=${r.name}`);
                    if (nickClean) {
                        // Dois pontos (:) PURO e sem codificação para o TMS
                        tmsTargetsPendentes.push(`publication_target=${r.name}:${nickClean}-sp`);
                    }
                }
            });
            allCategories.forEach(id => {
                if (id) tmsTargetsPendentes.push(`publication_target=${id}`);
            });
            const urlPendentes = `${CONSTANTS.BASE_IPTV}/tms/task/todo?${tmsFixedStartPendentes}&${tmsTargetsPendentes.join('&')}&answer_statuses=draft&with_apply_moment=true`;


            // --- MONTAGEM DA QUERY DE TAREFAS EXPIRADAS (Targets no MEIO com ?) [Log 123] ---
            const tmsFixedStartExpiradas = "expired_only=true&limit=100&offset=0&filter_expired=false&is_exam=false&with_answer=true&is_essay=false";
            const tmsTargetsExpiradas = [];
            rooms.forEach(r => {
                if (r.name) {
                    tmsTargetsExpiradas.push(`publication_target=${r.name}`);
                    if (nickClean) {
                        tmsTargetsExpiradas.push(`publication_target=${r.name}:${nickClean}-sp`);
                    }
                }
            });
            allCategories.forEach(id => {
                if (id) tmsTargetsExpiradas.push(`publication_target=${id}`);
            });
            const urlExpiradas = `${CONSTANTS.BASE_IPTV}/tms/task/todo?${tmsFixedStartExpiradas}&${tmsTargetsExpiradas.join('&')}&answer_statuses=draft&with_apply_moment=true`;


            // --- MONTAGEM DA QUERY DE REDAÇÕES PENDENTES ---
            const urlRedacoes = `${CONSTANTS.BASE_IPTV}/tms/task/todo?${tmsTargetsPendentes.join('&')}&is_essay=true&filter_expired=true&with_answer=true`;

            // EXECUÇÃO DA TÉCNICA DOS SUPER LOGS NO CONSOLE DO RENDER
            console.log(`\n🔗 [SUPER LOG] URL SURVEY: ${urlSurvey}\n`);
            console.log(`🔗 [SUPER LOG] URL PENDENTES: ${urlPendentes}\n`);
            console.log(`🔗 [SUPER LOG] URL EXPIRADAS: ${urlExpiradas}\n`);

            // Execução paralela controlada
            try {
                const [surveyRes, pendentesRaw, expiradasRaw, redacoesRaw] = await Promise.all([
                    axios.get(urlSurvey, configIptvBase),
                    axios.get(urlPendentes, configIptvBase),
                    axios.get(urlExpiradas, configIptvBase),
                    axios.get(urlRedacoes, configIptvBase)
                ]);

                // ----------------------------------------------------------
                // 5. FILTRAGEM CIRÚRGICA DE DADOS (CORTES TEMPORAIS)
                // ----------------------------------------------------------
                const rawPendentesList = Array.isArray(pendentesRaw.data) ? pendentesRaw.data : (pendentesRaw.data?.data || []);
                pendentes = rawPendentesList.filter(t =>
                    (t.answer_id === null || !t.answer_id) && new Date(t.publish_at || t.start_date) >= dataInicioBimestre
                ).length;

                const rawExpiradasList = Array.isArray(expiradasRaw.data) ? expiradasRaw.data : (expiradasRaw.data?.data || []);
                expiradas = rawExpiradasList.filter(t =>
                    (t.answer_id === null || !t.answer_id) && new Date(t.expire_at || t.end_date) >= dataInicioBimestre
                ).length;

                const rawRedacoesList = Array.isArray(redacoesRaw.data) ? redacoesRaw.data : (redacoesRaw.data?.data || []);
                redacoes = rawRedacoesList.filter(t =>
                    (t.answer_id === null || !t.answer_id) && new Date(t.publish_at || t.start_date) >= dataInicioBimestre
                ).length;

                avaliacoes = surveyRes.data?.count || surveyRes.data?.required_count || 0;

            } catch (errBatch) {
                console.error(`❌ [SUPER LOG DETECTED ERROR] Falha na requisição Axios:`, errBatch.response?.status || errBatch.message);
                console.error(`❌ URL que gerou a falha:`, errBatch.config?.url);
            }
        }

        // ----------------------------------------------------------
        // RETORNO HIGIENIZADO E COMPATÍVEL
        // ----------------------------------------------------------
        res.json({
            aluno: {
                nome: nomeCompletoAluno,
                codigo: raCompletoFormatado, 
                escola: infoTurma.NomeEscola || 'Não Informada',
                turma: infoTurma.DescricaoTurma || 'Não Informada'
            },
            indicadores: {
                pendentes: pendentes,
                expiradas: expiradas,
                avaliacoes: avaliacoes,
                redacoes: redacoes
            }
        });

    } catch (error) {
        console.error(`[BFF CRITICAL GLOBAL ERROR]: ${error.message}`);
        res.status(500).json({ error: "Falha geral no ecossistema do BFF." });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`BFF Super Logs ativo na porta ${PORT}`));
